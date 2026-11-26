import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type * as AgentRequestModule from "../../../../packages/pi-claude/agent-request";
import type { BridgeEvent, TokenUsage } from "../../../../packages/pi-claude/bridge";
import type * as ModelsModule from "../../../../packages/pi-claude/models";
import type * as RunnerModule from "../../../../packages/pi-claude/sdk/runner";
import type { RunSdkQuery } from "../../../../packages/pi-claude/sdk/runner";
import { snapshotLoader, snapshotModel } from "./snapshot";

type TurnRecord = {
  readonly session: string;
  readonly turn: number;
  readonly text: string;
  readonly end: string;
  readonly usage: TokenUsage | undefined;
  readonly promptTokens: number;
  readonly readShare: number;
  readonly resultPromptTokens: number | undefined;
  readonly numTurns: number | undefined;
  readonly modelUsagePromptTokens: number;
  readonly modelUsageKeys: readonly string[];
  readonly resultUsage: SDKResultMessage["usage"] | undefined;
};

type ModelUsageCheck = {
  readonly turn: string;
  readonly resultPrompt: number | undefined;
  readonly numTurns: number | undefined;
  readonly modelUsagePrompt: number;
  readonly models: readonly string[];
};

type CheckValue =
  | number
  | undefined
  | readonly (string | number | undefined)[]
  | readonly ModelUsageCheck[];

type Check = {
  readonly status: "passed" | "failed";
  readonly value: CheckValue;
  readonly threshold: string;
};

class BlockedError extends Error {}

const { values } = parseArgs({
  options: {
    package: { type: "string" },
    model: { type: "string", default: "claude-5.5-sonnet" },
  },
});

const packageDir = path.resolve(values.package ?? "packages/pi-claude");
const modelId = values.model;
const load = snapshotLoader(packageDir);
const { buildAgentRequest } = await load<typeof AgentRequestModule>("agent-request.ts");
const { createClaudeAgentSdkRunner } = await load<typeof RunnerModule>("sdk/runner.ts");
const { models } = await load<typeof ModelsModule>("models.ts");

const entry = models.find((candidate) => candidate.id === modelId);

if (entry === undefined) {
  throw new Error(`unknown model ${modelId}`);
}

const model = snapshotModel(entry);

const nonce = randomUUID();

const guidelines = Array.from(
  { length: 260 },
  (_, index) =>
    `Guideline ${index}: keep edits minimal, explain reasoning briefly, and prefer the read tool when inspecting file ${index}.`,
);

const systemPrompt = [
  `Verification run ${nonce}.`,
  "You are a coding assistant inside a cache verification harness.",
  ...guidelines,
].join("\n");

const tools = [
  {
    name: "read",
    description: "Read a file from the workspace.",
    parameters: Type.Object({ path: Type.String() }),
  },
];

let lastResult: SDKResultMessage | undefined;
const readLastResultAssignedByQueryObserver = (): SDKResultMessage | undefined => lastResult;

const runSdkQuery: RunSdkQuery = (params) =>
  (async function* observe() {
    for await (const message of query(params)) {
      if (message.type === "result") {
        lastResult = message;
      }

      yield message;
    }
  })();

const run = createClaudeAgentSdkRunner({ runSdkQuery });

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const BLOCKED_CATEGORIES = new Set(["authentication", "usage-limit"]);
const BLOCKED_TEXT = /usage limit|rate limit|authentication|allowance|sign in|log in/iu;

const turns: TurnRecord[] = [];

async function runTurn(
  session: string,
  turn: number,
  messages: readonly Message[],
): Promise<TurnRecord> {
  lastResult = undefined;
  const context = normalizeContext({ systemPrompt, tools, messages: [...messages] });
  const events: BridgeEvent[] = [];

  for await (const event of run(buildAgentRequest(context), model, { reasoning: "low" })) {
    events.push(event);
  }

  const last = events.at(-1);

  if (last?.type === "failed") {
    const { error } = last;
    const category = "category" in error ? error.category : undefined;
    const detail = `${error._tag}:${category ?? ""} ${error.message}`;

    if (
      (category !== undefined && BLOCKED_CATEGORIES.has(category)) ||
      BLOCKED_TEXT.test(error.message)
    ) {
      throw new BlockedError(`${session} turn ${turn} blocked: ${detail}`);
    }

    throw new Error(`${session} turn ${turn} failed: ${detail}`);
  }

  let usage: TokenUsage | undefined;

  for (const event of events) {
    if (event.type === "usage") {
      usage = event.usage;
    }
  }

  const promptTokens = usage === undefined ? 0 : usage.input + usage.cacheRead + usage.cacheWrite;
  const observed = readLastResultAssignedByQueryObserver();
  const raw = observed?.usage;
  const modelUsage = observed?.modelUsage ?? {};

  const record: TurnRecord = {
    session,
    turn,
    text: events
      .flatMap((event) => (event.type === "text_delta" ? [event.text] : []))
      .join("")
      .trim(),
    end: last?.type ?? "none",
    usage,
    promptTokens,
    readShare:
      promptTokens === 0 ? 0 : Math.round((1000 * (usage?.cacheRead ?? 0)) / promptTokens) / 1000,
    resultPromptTokens:
      raw === undefined
        ? undefined
        : (raw.input_tokens ?? 0) +
          (raw.cache_read_input_tokens ?? 0) +
          (raw.cache_creation_input_tokens ?? 0),
    numTurns: observed?.num_turns,
    modelUsagePromptTokens: Object.values(modelUsage).reduce(
      (sum, value) =>
        sum +
        (value.inputTokens ?? 0) +
        (value.cacheReadInputTokens ?? 0) +
        (value.cacheCreationInputTokens ?? 0),
      0,
    ),
    modelUsageKeys: Object.keys(modelUsage),
    resultUsage: raw,
  };

  process.stderr.write(
    `${session} turn ${turn}: end=${record.end} read=${usage?.cacheRead} write=${usage?.cacheWrite} input=${usage?.input} share=${record.readShare}\n`,
  );
  turns.push(record);

  return record;
}

async function runSession(session: string, count: number, fanout: number): Promise<TurnRecord[]> {
  const messages: Message[] = [];
  const records: TurnRecord[] = [];
  let callId = 0;

  for (let turn = 1; turn <= count; turn += 1) {
    messages.push({
      role: "user",
      content: `[session ${session}] Turn ${turn}: reply with exactly ACK${turn} and nothing else.`,
      timestamp: 0,
    });
    // oxlint-disable-next-line eslint/no-await-in-loop -- each turn replays the previous turn transcript
    const record = await runTurn(session, turn, messages);
    records.push(record);

    const calls = Array.from({ length: fanout }, () => {
      callId += 1;

      return {
        type: "toolCall" as const,
        id: `call_${session}_${callId}`,
        name: "read",
        arguments: { path: `src/file-${callId}.ts` },
      };
    });

    messages.push({
      role: "assistant",
      content: [{ type: "text", text: record.text }, ...calls],
      api: "claude",
      provider: "claude",
      model: modelId,
      stopReason: fanout > 0 ? "toolUse" : "stop",
      timestamp: 0,
      usage: zeroUsage,
    });

    for (const call of calls) {
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: "read",
        isError: false,
        content: [
          { type: "text", text: `export const value${call.id} = 1; // ${"padding ".repeat(30)}` },
        ],
        timestamp: 0,
      });
    }
  }

  return records;
}

function check(passed: boolean, value: CheckValue, threshold: string): Check {
  return { status: passed ? "passed" : "failed", value, threshold };
}

type ProbeReport = {
  probe: string;
  model: string;
  packageDir: string;
  nonce: string;
  systemPromptCharacters: number;
  turns: readonly TurnRecord[];
  checks?: Readonly<Record<string, Check>>;
  status?: "passed" | "failed" | "blocked";
  error?: string;
};

const output: ProbeReport = {
  probe: "pi-claude-cache",
  model: modelId,
  packageDir,
  nonce,
  systemPromptCharacters: systemPrompt.length,
  turns,
};

let exitCode: number;

try {
  const sessionA = await runSession("A", 3, 0);
  const sessionB = await runSession("B", 1, 0);
  const sessionC = await runSession("C", 3, 25);
  const laterA = sessionA.slice(1);

  const checks = {
    "turns-completed": check(
      turns.every((turn) => turn.end === "done" && turn.usage !== undefined),
      turns.map((turn) => turn.end),
      "every turn ends done with a usage event",
    ),
    "steady-read-share": check(
      laterA.every((turn) => turn.readShare >= 0.8),
      laterA.map((turn) => turn.readShare),
      "session A turns 2-3 cacheRead/prompt >= 0.8",
    ),
    "steady-suffix-write": check(
      laterA.every((turn) => (turn.usage?.cacheWrite ?? Infinity) < 1500),
      laterA.map((turn) => turn.usage?.cacheWrite),
      "session A turns 2-3 cacheWrite < 1500",
    ),
    "no-side-requests": check(
      turns.every(
        (turn) =>
          turn.numTurns === 1 &&
          turn.modelUsageKeys.length === 1 &&
          turn.resultPromptTokens === turn.modelUsagePromptTokens,
      ),
      turns.map((turn) => ({
        turn: `${turn.session}${turn.turn}`,
        resultPrompt: turn.resultPromptTokens,
        numTurns: turn.numTurns,
        modelUsagePrompt: turn.modelUsagePromptTokens,
        models: turn.modelUsageKeys,
      })),
      "num_turns == 1 and result.usage prompt == sum(modelUsage prompt) with exactly one model, every turn",
    ),
    "cross-session-preamble": check(
      (sessionB[0]?.readShare ?? 0) >= 0.7,
      sessionB[0]?.readShare,
      "session B turn 1 cacheRead/prompt >= 0.7",
    ),
    "fanout-read-share": check(
      (sessionC[2]?.readShare ?? 0) >= 0.6,
      sessionC[2]?.readShare,
      "session C (25 tool results/turn) turn 3 cacheRead/prompt >= 0.6",
    ),
  };

  output.checks = checks;
  exitCode = Object.values(checks).every((item) => item.status === "passed") ? 0 : 1;
  output.status = exitCode === 0 ? "passed" : "failed";
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const blocked = error instanceof BlockedError || BLOCKED_TEXT.test(message);
  exitCode = blocked ? 2 : 1;
  output.status = blocked ? "blocked" : "failed";
  output.error = message;
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

process.exitCode = exitCode;
