import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
/** One offline trial (one scenario, one arm) in its own process. Prints one JSON metrics line.
 *  node --import jiti/register test/codemode/trial.ts <scenario> <direct|codemode>
 *  Simulated gateway + scripted recorder model; no provider, credential or network is used. */
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import adapter from "../../index.js";
import { EXPECTED_OPS, EXPECTED_READS } from "./corpus.js";
import { plan } from "./recorder.js";
import { startFixture } from "./serve.js";

export type Metrics = {
  scenario: string;
  arm: string;
  rounds: number;
  modelToolCalls: number;
  gatewayOps: number;
  /** UTF-8 bytes of tool-result text blocks in the final transcript (what the model saw from tools). */
  toolResultBytes: number;
  /** Cumulative UTF-8 bytes of JSON-serialized transcripts handed to the provider each round,
   *  including system prompt and tool declarations. Not tokens. */
  cumulativeRequestBytes: number;
  firstRequestBytes: number;
  correct: boolean;
  finalAnswer: string;
  /** Offline CPU/roundtrip wall time, not live latency. */
  elapsedMs: number;
  activeTools: string[];
  /** Gateway receipts: exactly the expected state.get set (each once, exact revision, ok) and expected total ops. */
  traceOk: boolean;
};

type Block = { type: string; text?: string };
type Arm = "direct" | "codemode";
type Fixture = Awaited<ReturnType<typeof startFixture>>;
type Counters = { requestBytes: number[]; calls: number };
type Step = ReturnType<typeof plan>;

function blocks(content: unknown): Block[] {
  return Array.isArray(content)
    ? content.filter((b): b is Block => typeof b === "object" && b !== null)
    : [];
}
function assistantMessage(model: Model<Api>, step: Step, counters: Counters): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (step.kind === "text") {
    content.push({ type: "text", text: step.text });
  } else {
    for (const call of step.calls) {
      counters.calls += 1;
      content.push({
        type: "toolCall",
        id: `call-${counters.calls}`,
        name: call.name,
        arguments: call.arguments,
      });
    }
  }
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    content,
    stopReason: step.kind === "text" ? "stop" : "toolUse",
    // Dummy counters: never evidence of tokens or cost.
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function recorderExtension(scenario: string, arm: Arm, counters: Counters) {
  return (pi: ExtensionAPI) => {
    pi.registerProvider("recorder", {
      baseUrl: "offline://recorder",
      apiKey: "offline-not-a-credential",
      api: "offline-recorder",
      models: [
        {
          id: "scripted",
          name: "Deterministic offline recorder",
          reasoning: false,
          input: ["text"],
          contextWindow: 200_000,
          maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      streamSimple: (model, transcript) => {
        counters.requestBytes.push(Buffer.byteLength(JSON.stringify(transcript.messages)));
        const stream = createAssistantMessageEventStream();
        const message = assistantMessage(model, plan(scenario, arm, transcript.messages), counters);
        queueMicrotask(() => {
          stream.push({ type: "start", partial: { ...message, content: [], stopReason: "stop" } });
          stream.push({
            type: "done",
            reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
            message,
          });
          stream.end(message);
        });
        return stream;
      },
    });
  };
}
async function createSession(fixture: Fixture, arm: Arm, recorder: (pi: ExtensionAPI) => void) {
  const settingsManager = SettingsManager.inMemory({
    quietStartup: true,
    retry: { enabled: false },
    compaction: { enabled: false },
    ...(arm === "codemode" ? { defaultTools: ["+codemode"] } : {}),
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: fixture.profile.cwd,
    agentDir: fixture.profile.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    extensionFactories: [
      ...(arm === "codemode" ? [createCodemodeExtension({ mode: "on" })] : []),
      adapter,
      recorder,
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: fixture.profile.cwd,
    agentDir: fixture.profile.agentDir,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(),
    noTools: "builtin",
  });
  return session;
}
async function prepare(session: AgentSession, fixture: Fixture, arm: Arm): Promise<string[]> {
  await session.bindExtensions({});
  if (arm === "codemode") {
    session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
  }
  const model = session.modelRuntime.getModel("recorder", "scripted");
  if (model === undefined) {
    throw new Error("recorder model missing");
  }
  await session.setModel(model);
  for (let i = 0; i < 300 && fixture.gateway.count("register") === 0; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  const active = session.getActiveToolNames();
  const expectedTools = [
    "session_interest",
    "session_peers",
    "session_report",
    "session_send",
    "session_state",
    "session_take",
    ...(arm === "codemode" ? ["codemode"] : []),
  ];
  if (
    fixture.gateway.count("register") === 0 ||
    JSON.stringify(active.toSorted()) !== JSON.stringify(expectedTools.toSorted())
  ) {
    throw new Error(`adapter not ready or tool set differs: ${active.join(",")}`);
  }
  return active;
}
function toolResultBytesOf(session: AgentSession): number {
  return session.messages
    .filter((m) => m.role === "toolResult")
    .reduce(
      (sum, m) =>
        sum + blocks(m.content).reduce((inner, b) => inner + Buffer.byteLength(b.text ?? ""), 0),
      0,
    );
}
function answerMatches(answer: string, expected: unknown): boolean {
  try {
    return JSON.stringify(JSON.parse(answer)) === JSON.stringify(expected);
  } catch {
    return false;
  }
}
function traceMatches(fixture: Fixture, scenario: string): boolean {
  const gets = fixture.gateway.receipts.filter((r) => r.op === "state.get");
  const observed = gets.map((r) => `${r.sessionId}:${r.key}:${r.expectedRevision}`).toSorted();
  const expectedReads = (EXPECTED_READS[scenario] ?? []).toSorted();
  return (
    JSON.stringify(observed) === JSON.stringify(expectedReads) &&
    gets.every((r) => r.outcome === "ok") &&
    gatewayOpCount(fixture) === EXPECTED_OPS[scenario]
  );
}
function gatewayOpCount(fixture: Fixture): number {
  return fixture.gateway.requests.filter((r) => r.op !== "register").length;
}
async function execute(
  session: AgentSession,
  fixture: Fixture,
  scenario: string,
  arm: Arm,
  counters: Counters,
  active: string[],
): Promise<Metrics> {
  const task = fixture.task;
  if (task === undefined) {
    throw new Error(`No task for ${scenario}`);
  }
  const started = performance.now();
  await session.prompt(task.prompt);
  const elapsedMs = Math.round(performance.now() - started);
  const finalAnswer = session.getLastAssistantText() ?? "";
  return {
    scenario,
    arm,
    rounds: counters.requestBytes.length,
    modelToolCalls: counters.calls,
    gatewayOps: gatewayOpCount(fixture),
    toolResultBytes: toolResultBytesOf(session),
    cumulativeRequestBytes: counters.requestBytes.reduce((a, b) => a + b, 0),
    firstRequestBytes: counters.requestBytes[0] ?? 0,
    correct: answerMatches(finalAnswer, task.expected),
    finalAnswer,
    elapsedMs,
    activeTools: active,
    traceOk: traceMatches(fixture, scenario),
  };
}
async function runTrial(scenario: string, arm: Arm): Promise<Metrics> {
  const fixture = await startFixture(scenario, arm === "codemode");
  process.env.PI_CODING_AGENT_DIR = fixture.profile.agentDir;
  const counters: Counters = { requestBytes: [], calls: 0 };
  const session = await createSession(fixture, arm, recorderExtension(scenario, arm, counters));
  try {
    const active = await prepare(session, fixture, arm);
    return await execute(session, fixture, scenario, arm, counters, active);
  } finally {
    // Supported order: extension shutdown hooks (adapter closes its runtime) before invalidating contexts.
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    await fixture.stop();
  }
}

if (process.argv[1]?.endsWith("trial.ts") === true) {
  const [scenario = "aggregate", arm = "direct"] = process.argv.slice(2);
  const metrics = await runTrial(scenario, arm === "codemode" ? "codemode" : "direct");
  process.stdout.write(`RESULT ${JSON.stringify(metrics)}\n`);
}
