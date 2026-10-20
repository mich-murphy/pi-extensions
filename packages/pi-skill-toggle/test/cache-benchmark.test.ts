/**
 * Deterministic prompt-cache reuse benchmark for skill toggle.
 *
 * Runs real in-process Pi sessions (`createAgentSession`) against pi-ai's faux provider, with
 * the extension registered through an inline extension factory and an in-memory toggle store.
 * Every provider request is captured and rendered three ways, then compared with the previous
 * request of the same session. Only invariants that hold today are asserted; the rest is data.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  getSystemMessageText,
  renderSystemMessageUpdate,
  resolveTranscript,
} from "@earendil-works/pi-ai";
import type { Message, TranscriptContext } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { buildAgentRequest } from "../../pi-claude-sdk/agent-request";
import { registerSkillToggle } from "../index";
import { resourcePathId } from "../resource-path";
import type { ToggleValue } from "../resources";
import { err } from "../result";
import { ToggleStateFile, ToggleStateUnavailable } from "../state";
import type { ToggleStateStore } from "../state";

const GLOBAL_SKILLS = [
  "research",
  "release-notes",
  "incident-review",
  "api-design",
  "db-migrations",
  "frontend-a11y",
  "perf-profiling",
  "security-audit",
] as const;
const PROJECT_SKILLS = ["deploy", "seed-data"] as const;

function description(name: string): string {
  return `Use when the task involves ${name.replaceAll("-", " ")}: gather the relevant files, follow the team checklist for ${name}, record every decision with its reason, prefer small reversible steps, verify the result with the documented commands, and report remaining risks, open questions and follow-up work to the user before finishing the task.`;
}

function writeSkill(root: string, name: string): void {
  const file = join(root, name, "SKILL.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `---\nname: ${name}\ndescription: "${description(name)}"\n---\n\n# ${name}\n\nSteps for ${name}.\n`,
  );
}

type Fixture = { readonly root: string; readonly agentDir: string; readonly cwd: string };

function createFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skill-toggle-bench-")));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  for (const name of GLOBAL_SKILLS) {
    writeSkill(join(agentDir, "skills"), name);
  }
  for (const name of PROJECT_SKILLS) {
    writeSkill(join(cwd, ".agents", "skills"), name);
  }
  writeFileSync(join(agentDir, "AGENTS.md"), "# Global rules\n\nAnswer concisely. Cite files.\n");
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({ faux: { type: "api_key", key: "faux" } }),
  );
  writeFileSync(join(cwd, "AGENTS.md"), "# Project rules\n\nRun npm run check before finishing.\n");
  writeFileSync(join(cwd, "README.md"), "# Demo project\n\nA fixture for the cache benchmark.\n");
  execFileSync("git", ["init", "-q"], { cwd });
  return { root, agentDir, cwd };
}

let storeCount = 0;

/** A real state file the benchmark mutates between prompts, with injectable load failures. */
class MemoryStore implements ToggleStateStore {
  failLoads = 0;
  private readonly file: ToggleStateFile;

  constructor(private readonly fixture: Fixture) {
    storeCount += 1;
    this.file = new ToggleStateFile(join(fixture.root, `state-${storeCount}.json`));
  }

  load: ToggleStateStore["load"] = () => {
    if (this.failLoads > 0) {
      this.failLoads--;
      return err(new ToggleStateUnavailable("load", "/state.json", "EACCES", undefined));
    }
    return this.file.load();
  };

  set: ToggleStateStore["set"] = (id, value, origin) => this.file.set(id, value, origin);

  toggle(path: string, value: ToggleValue): this {
    const saved = this.file.set(resourcePathId(path, this.fixture.cwd), value);
    if (saved._tag === "err") {
      throw saved.error;
    }
    return this;
  }
}

type Step = {
  readonly before?: (store: MemoryStore, fixture: Fixture) => void;
  readonly compactBefore?: boolean;
  readonly toolCall?: boolean;
  readonly switchModel?: string;
};

type Scenario = {
  readonly name: string;
  readonly initial?: (store: MemoryStore, fixture: Fixture) => void;
  readonly steps: readonly Step[];
};

type Rendering = "midConvo" | "collapsed" | "claudeSdk";
const RENDERINGS: readonly Rendering[] = ["midConvo", "collapsed", "claudeSdk"];

type Rendered = { readonly text: string; readonly blocks?: readonly string[] };

function renderMessage(message: Message, head: boolean): string {
  if (message.role === "system") {
    return `system:${head ? getSystemMessageText(message) : renderSystemMessageUpdate(message)}`;
  }
  if (message.role === "toolResult") {
    return `toolResult:${message.toolCallId}:${message.toolName}:${JSON.stringify(message.content)}`;
  }
  return `${message.role}:${JSON.stringify(message.content)}`;
}

function renderMessages(messages: readonly Message[]): string {
  return messages.map((message, index) => renderMessage(message, index === 0)).join("\n\n");
}

function render(context: TranscriptContext, rendering: Rendering): Rendered {
  if (rendering === "midConvo") {
    return { text: renderMessages(context.messages) };
  }
  if (rendering === "collapsed") {
    return { text: renderMessages(resolveTranscript(context, false).messages) };
  }
  const blocks = buildAgentRequest(context).promptBlocks.map((block) => block.text);
  return { text: blocks.join(""), blocks };
}

function commonPrefix(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  let index = 0;
  while (index < length && a[index] === b[index]) {
    index++;
  }
  return index;
}

type RequestReuse = {
  readonly chars: number;
  readonly reused: number;
  readonly previousChars: number;
  readonly reusedBlocks?: number;
  readonly previousBlocks?: number;
};

function reuse(previous: Rendered | undefined, current: Rendered): RequestReuse {
  if (previous === undefined) {
    return { chars: current.text.length, reused: 0, previousChars: 0 };
  }
  if (current.blocks === undefined || previous.blocks === undefined) {
    return {
      chars: current.text.length,
      reused: commonPrefix(previous.text, current.text),
      previousChars: previous.text.length,
    };
  }
  let blocks = 0;
  let reused = 0;
  while (
    blocks < previous.blocks.length &&
    blocks < current.blocks.length &&
    previous.blocks[blocks] === current.blocks[blocks]
  ) {
    reused += current.blocks[blocks]?.length ?? 0;
    blocks++;
  }
  return {
    chars: current.text.length,
    reused,
    previousChars: previous.text.length,
    reusedBlocks: blocks,
    previousBlocks: previous.blocks.length,
  };
}

type RenderingSummary = {
  readonly requests: number;
  readonly totalChars: number;
  readonly reusedChars: number;
  readonly unreusedChars: number;
  readonly reuseRatio: number;
  readonly perRequest: readonly RequestReuse[];
};

type ScenarioReport = {
  readonly name: string;
  readonly requests: number;
  readonly systemPatches: number;
  readonly patchChars: number;
  readonly noteMessages: number;
  readonly noteChars: number;
  readonly compaction: string | undefined;
  readonly renderings: Readonly<Record<Rendering, RenderingSummary>>;
};

function summarize(contexts: readonly TranscriptContext[], rendering: Rendering): RenderingSummary {
  const rendered = contexts.map((context) => render(context, rendering));
  const perRequest = rendered.map((current, index) => reuse(rendered[index - 1], current));
  const later = perRequest.slice(1);
  const laterChars = later.reduce((sum, request) => sum + request.chars, 0);
  const reusedChars = later.reduce((sum, request) => sum + request.reused, 0);
  const totalChars = perRequest.reduce((sum, request) => sum + request.chars, 0);
  return {
    requests: perRequest.length,
    totalChars,
    reusedChars,
    unreusedChars: totalChars - reusedChars,
    reuseRatio: laterChars === 0 ? 1 : reusedChars / laterChars,
    perRequest,
  };
}

const REPLY = "Done. I checked the relevant files and the change is ready for review. ".repeat(4);
const NOTE_TYPE = "pi-skill-toggle";
const MODEL_IDS = ["faux-a", "faux-b"] as const;

type Faux = ReturnType<typeof fauxProvider>;
type Run = {
  readonly fixture: Fixture;
  readonly store: MemoryStore;
  readonly faux: Faux;
  readonly session: AgentSession;
  readonly contexts: TranscriptContext[];
};

async function startSession(fixture: Fixture, store: MemoryStore): Promise<Run> {
  const faux = fauxProvider({ provider: "faux", models: MODEL_IDS.map((id) => ({ id })) });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(fixture.agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } });
  settingsManager.setProjectTrusted(true);
  const resourceLoader = new DefaultResourceLoader({
    cwd: fixture.cwd,
    agentDir: fixture.agentDir,
    settingsManager,
    extensionFactories: [
      (pi) => {
        registerSkillToggle(pi, store);
      },
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: fixture.cwd,
    agentDir: fixture.agentDir,
    model: faux.getModel(),
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(fixture.cwd),
    settingsManager,
    tools: ["read", "bash"],
  });
  return { fixture, store, faux, session, contexts: [] };
}

async function compact(run: Run): Promise<string> {
  // Compaction may summarize history and a split turn prefix separately.
  run.faux.setResponses(
    Array.from({ length: 3 }, () => fauxAssistantMessage("Summary: earlier turns edited files.")),
  );
  try {
    await run.session.compact();
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    run.faux.setResponses([]);
  }
}

async function switchModel(run: Run, modelId: string): Promise<void> {
  const model = run.faux.getModel(modelId);
  if (model === undefined) {
    throw new Error(`unknown faux model ${modelId}`);
  }
  await run.session.setModel(model);
}

function queueResponses(run: Run, step: Step, index: number): void {
  const capture = (context: TranscriptContext): void => {
    run.contexts.push(structuredClone(context));
  };
  if (step.toolCall === true) {
    const readme = join(run.fixture.cwd, "README.md");
    run.faux.appendResponses([
      (context) => {
        capture(context);
        return fauxAssistantMessage(
          fauxToolCall("read", { path: readme }, { id: `call-${index}` }),
          { stopReason: "toolUse" },
        );
      },
    ]);
  }
  run.faux.appendResponses([
    (context) => {
      capture(context);
      return fauxAssistantMessage(`${REPLY}(turn ${index + 1})`);
    },
  ]);
}

/** Runs one step; returns the compaction outcome when the step compacted first. */
async function runStep(run: Run, step: Step, index: number): Promise<string | undefined> {
  const compaction = step.compactBefore === true ? await compact(run) : undefined;
  if (step.switchModel !== undefined) {
    await switchModel(run, step.switchModel);
  }
  step.before?.(run.store, run.fixture);
  queueResponses(run, step, index);
  await run.session.prompt(`Prompt ${index + 1}: please continue with the next part of the task.`);
  return compaction;
}

type SessionMessage = AgentSession["messages"][number];
type NoteMessage = Extract<SessionMessage, { role: "custom" }>;

function contentChars(content: NoteMessage["content"]): number {
  if (typeof content === "string") {
    return content.length;
  }
  return content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0);
}

function toggleNotes(messages: readonly SessionMessage[]): readonly NoteMessage[] {
  return messages.filter(
    (message): message is NoteMessage =>
      message.role === "custom" && message.customType === NOTE_TYPE,
  );
}

function systemPatches(
  contexts: readonly TranscriptContext[],
): readonly Extract<Message, { role: "system" }>[] {
  return (contexts.at(-1)?.messages ?? []).filter(
    (message, index): message is Extract<Message, { role: "system" }> =>
      index > 0 && message.role === "system",
  );
}

function buildReport(name: string, run: Run, compaction: string | undefined): ScenarioReport {
  const patches = systemPatches(run.contexts);
  const notes = toggleNotes(run.session.messages);
  return {
    name,
    requests: run.contexts.length,
    systemPatches: patches.length,
    patchChars: patches.reduce((sum, patch) => sum + renderSystemMessageUpdate(patch).length, 0),
    noteMessages: notes.length,
    noteChars: notes.reduce((sum, note) => sum + contentChars(note.content), 0),
    compaction,
    renderings: {
      midConvo: summarize(run.contexts, "midConvo"),
      collapsed: summarize(run.contexts, "collapsed"),
      claudeSdk: summarize(run.contexts, "claudeSdk"),
    },
  };
}

async function runScenario(
  fixture: Fixture,
  scenario: Scenario,
): Promise<{ readonly report: ScenarioReport; readonly contexts: readonly TranscriptContext[] }> {
  const store = new MemoryStore(fixture);
  scenario.initial?.(store, fixture);
  const run = await startSession(fixture, store);
  let compaction: string | undefined;
  try {
    for (const [index, step] of scenario.steps.entries()) {
      compaction = (await runStep(run, step, index)) ?? compaction;
    }
    return { report: buildReport(scenario.name, run, compaction), contexts: run.contexts };
  } finally {
    run.session.dispose();
  }
}

const globalSkill = (fixture: Fixture, name: string): string =>
  join(fixture.agentDir, "skills", name, "SKILL.md");
const projectSkill = (fixture: Fixture, name: string): string =>
  join(fixture.cwd, ".agents", "skills", name, "SKILL.md");

const plain: Step = {};
const withTool: Step = { toolCall: true };

function stepsWith(at: number, step: Step, count = 6): readonly Step[] {
  return Array.from({ length: count }, (_, index) => {
    if (index === at) {
      return step;
    }
    return index === 1 ? withTool : plain;
  });
}

const SCENARIOS: readonly Scenario[] = [
  { name: "a-steady", steps: stepsWith(-1, plain) },
  {
    name: "b-global-skill-off",
    steps: stepsWith(3, {
      before: (store, fixture) => store.toggle(globalSkill(fixture, "api-design"), "disabled"),
    }),
  },
  {
    name: "c-project-skill-on",
    initial: (store, fixture) => store.toggle(projectSkill(fixture, "deploy"), "disabled"),
    steps: stepsWith(3, {
      before: (store, fixture) => store.toggle(projectSkill(fixture, "deploy"), "enabled"),
    }),
  },
  {
    name: "d-instruction-off",
    steps: stepsWith(3, {
      before: (store, fixture) => store.toggle(join(fixture.cwd, "AGENTS.md"), "disabled"),
    }),
  },
  {
    name: "e-batch-toggles",
    steps: stepsWith(3, {
      before: (store, fixture) => {
        store.toggle(globalSkill(fixture, "api-design"), "disabled");
        store.toggle(globalSkill(fixture, "db-migrations"), "disabled");
        store.toggle(projectSkill(fixture, "seed-data"), "disabled");
        store.toggle(join(fixture.agentDir, "AGENTS.md"), "disabled");
      },
    }),
  },
  {
    name: "f-toggle-and-back",
    steps: [
      plain,
      withTool,
      plain,
      { before: (store, fixture) => store.toggle(globalSkill(fixture, "research"), "disabled") },
      { before: (store, fixture) => store.toggle(globalSkill(fixture, "research"), "enabled") },
      plain,
    ],
  },
  {
    name: "g-load-failure-recovery",
    initial: (store, fixture) => store.toggle(globalSkill(fixture, "security-audit"), "disabled"),
    steps: stepsWith(3, {
      before: (store) => {
        store.failLoads = 1;
      },
    }),
  },
  {
    name: "h1-toggle-after-compaction",
    steps: stepsWith(3, {
      compactBefore: true,
      before: (store, fixture) => store.toggle(globalSkill(fixture, "api-design"), "disabled"),
    }),
  },
  {
    name: "h2-compaction-then-toggle-mid-epoch",
    steps: [
      plain,
      withTool,
      plain,
      { compactBefore: true },
      { before: (store, fixture) => store.toggle(globalSkill(fixture, "api-design"), "disabled") },
      plain,
    ],
  },
  {
    name: "j-model-switch-then-toggle",
    steps: [
      plain,
      withTool,
      { switchModel: "faux-b" },
      { before: (store, fixture) => store.toggle(globalSkill(fixture, "api-design"), "disabled") },
      plain,
      plain,
    ],
  },
  {
    name: "k-toggle-before-first-prompt",
    steps: stepsWith(0, {
      before: (store, fixture) => store.toggle(globalSkill(fixture, "api-design"), "disabled"),
    }),
  },
  {
    name: "l-toggle-off-then-on-between-prompts",
    steps: stepsWith(3, {
      before: (store, fixture) => {
        store.toggle(globalSkill(fixture, "research"), "disabled");
        store.toggle(globalSkill(fixture, "research"), "enabled");
      },
    }),
  },
];

const NON_TOGGLE_SCENARIOS = new Set(["a-steady", "k-toggle-before-first-prompt"]);

/** Mean reuse ratio per rendering across scenarios that toggle mid-session. */
function toggleMeans(reports: readonly ScenarioReport[]): Readonly<Record<Rendering, number>> {
  const toggles = reports.filter((report) => !NON_TOGGLE_SCENARIOS.has(report.name));
  const mean = (rendering: Rendering): number =>
    toggles.reduce((sum, report) => sum + report.renderings[rendering].reuseRatio, 0) /
    Math.max(1, toggles.length);
  return { midConvo: mean("midConvo"), collapsed: mean("collapsed"), claudeSdk: mean("claudeSdk") };
}

const percent = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;

function summaryRows(reports: readonly ScenarioReport[]): readonly string[][] {
  const means = toggleMeans(reports);
  return RENDERINGS.map((rendering) => ["mean-toggle", rendering, percent(means[rendering])]);
}

function table(reports: readonly ScenarioReport[]): string {
  const rows = reports.flatMap((report) =>
    RENDERINGS.map((rendering) => {
      const summary = report.renderings[rendering];
      return [
        report.name,
        rendering,
        String(summary.requests),
        String(summary.totalChars),
        String(summary.reusedChars),
        String(summary.unreusedChars),
        percent(summary.reuseRatio),
        String(report.systemPatches),
        String(report.patchChars),
        String(report.noteMessages),
        String(report.noteChars),
        report.compaction ?? "-",
      ];
    }),
  );
  const header = [
    "scenario",
    "rendering",
    "req",
    "chars",
    "reused",
    "unreused",
    "reuse",
    "patches",
    "patchChars",
    "notes",
    "noteChars",
    "compaction",
  ];
  return [header, ...rows, ...summaryRows(reports)].map((row) => row.join("\t")).join("\n");
}

function firstRequestTexts(contexts: readonly TranscriptContext[]): readonly string[] {
  const [first] = contexts;
  return first === undefined ? [] : RENDERINGS.map((rendering) => render(first, rendering).text);
}

/** Requests of a steady session that do not reuse the whole previous request. */
function steadyReuseViolations(report: ScenarioReport | undefined): readonly string[] {
  if (report === undefined) {
    return ["missing a-steady report"];
  }
  return RENDERINGS.flatMap((rendering) =>
    report.renderings[rendering].perRequest.slice(1).flatMap((request, index) => {
      // The trailing "Continue" block is replaced by the next entry, so it never matches.
      const expected =
        request.reusedBlocks === undefined
          ? request.previousChars
          : (request.previousBlocks ?? 0) - 1;
      const actual = request.reusedBlocks ?? request.reused;
      return actual === expected
        ? []
        : [`${rendering} request ${index + 2}: ${actual} != ${expected}`];
    }),
  );
}

function writeReport(reports: readonly ScenarioReport[]): void {
  const out = process.env.PI_SKILL_TOGGLE_BENCH_OUT;
  if (out !== undefined && out !== "") {
    const summary = { toggleMeanReuse: toggleMeans(reports) };
    writeFileSync(out, `${JSON.stringify({ reports, summary }, undefined, 2)}\n`);
  }
}

describe("skill toggle prompt-cache benchmark", () => {
  let fixture: Fixture;
  const reports: ScenarioReport[] = [];

  beforeAll(() => {
    fixture = createFixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", fixture.agentDir);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  test("identical state renders byte-identical first requests", { timeout: 60_000 }, async () => {
    const scenario: Scenario = { name: "i-determinism", steps: [plain] };
    const first = await runScenario(fixture, scenario);
    const second = await runScenario(fixture, scenario);
    expect(firstRequestTexts(first.contexts)).toHaveLength(RENDERINGS.length);
    expect(firstRequestTexts(first.contexts)).toStrictEqual(firstRequestTexts(second.contexts));
  });

  test("measures reuse per scenario", { timeout: 120_000 }, async () => {
    for (const scenario of SCENARIOS) {
      const { report } = await runScenario(fixture, scenario);
      reports.push(report);
    }
    process.stdout.write(`${table(reports)}\n`);
    writeReport(reports);

    const steady = reports.find((report) => report.name === "a-steady");
    expect(steady?.systemPatches).toBe(0);
    expect(steadyReuseViolations(steady)).toStrictEqual([]);
    const early = reports.find((report) => report.name === "k-toggle-before-first-prompt");
    expect(early?.systemPatches).toBe(0);
    expect(early?.noteMessages).toBe(0);
    expect(steadyReuseViolations(early)).toStrictEqual([]);
  });
});
