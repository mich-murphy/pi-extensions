// Live prompt-cache probe for verify-pi-claude-sdk. From the repository root:
//   node_modules/.bin/jiti .agents/skills/verify-pi-claude-sdk/scripts/cache-probe.ts \
//     --package <dir containing agent-request.ts> [--model claude-5.5-sonnet]
// Drives the production path (Pi normalizeContext -> buildAgentRequest -> runner with the
// default subscription environment and the real SDK query). The query wrapper only observes
// terminal `result` messages; every SDK message passes through unchanged. Prints one JSON
// object. Exit 0 = all checks passed, 1 = a check or turn failed, 2 = blocked (auth/limit).
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { normalizeContext } from "@earendil-works/pi-ai";
import type {
  Api,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";

// Local structural types: only the stable signatures are relied on, so the probe survives
// internal request/runner changes (e.g. cache breakpoint fields).
type TokenUsage = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cacheWrite1h?: number;
};
type BridgeEvent = {
  readonly type: string;
  readonly text?: string;
  readonly usage?: TokenUsage;
  readonly error?: {
    readonly _tag?: string;
    readonly category?: string;
    readonly message?: string;
  };
};
type RunSdkQuery = (params: Parameters<typeof query>[0]) => AsyncIterable<unknown>;
type Runner = (
  request: unknown,
  model: Model<Api>,
  options?: SimpleStreamOptions,
) => AsyncIterable<BridgeEvent>;
type RawUsage = {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_creation?: Record<string, number | null>;
};
type RawModelUsage = Record<
  string,
  {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadInputTokens?: number;
    readonly cacheCreationInputTokens?: number;
  }
>;
type RawResult = {
  readonly isError: boolean;
  readonly subtype: unknown;
  readonly numTurns: number | undefined;
  readonly usage: RawUsage | undefined;
  readonly modelUsage: RawModelUsage;
};
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
  readonly resultUsage: RawUsage | undefined;
};
type Check = {
  readonly status: "passed" | "failed";
  readonly value: unknown;
  readonly threshold: string;
};

class BlockedError extends Error {}

const { values } = parseArgs({
  options: {
    package: { type: "string" },
    model: { type: "string", default: "claude-5.5-sonnet" },
  },
});
const packageDir = path.resolve(values.package ?? "packages/pi-claude-sdk");
const modelId = values.model;
const moduleUrl = (file: string): string => pathToFileURL(path.join(packageDir, file)).href;

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- dynamic import of the package snapshot under test
const { buildAgentRequest } = (await import(moduleUrl("agent-request.ts"))) as {
  buildAgentRequest: (context: TranscriptContext) => unknown;
};
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- dynamic import of the package snapshot under test
const { createClaudeAgentSdkRunner } = (await import(moduleUrl("sdk/runner.ts"))) as {
  createClaudeAgentSdkRunner: (options: { runSdkQuery: RunSdkQuery }) => Runner;
};
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- dynamic import of the package snapshot under test
const { models } = (await import(moduleUrl("models.ts"))) as {
  models: readonly (Record<string, unknown> & { readonly id: string })[];
};

const entry = models.find((candidate) => candidate.id === modelId);
if (entry === undefined) {
  throw new Error(`unknown model ${modelId}`);
}
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- registered entry plus the fields Pi adds at registration
const model = {
  ...entry,
  api: "claude-sdk",
  provider: "claude-sdk",
  baseUrl: "agent-sdk://local-claude-code",
} as unknown as Model<Api>;

// A fresh nonce at the very start keeps this run from reading a previous verification's
// cache; sessions within the run share it so cross-session reuse is observable.
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
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- plain JSON schema stands in for a TypeBox schema
const tools = [
  {
    name: "read",
    description: "Read a file from the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
] as unknown as NonNullable<Context["tools"]>;

let lastResult: RawResult | undefined;
// A getter defeats control-flow narrowing: the query wrapper assigns lastResult asynchronously.
const observedResult = (): RawResult | undefined => lastResult;
function isResult(message: unknown): message is {
  type: "result";
  is_error?: boolean;
  subtype?: unknown;
  num_turns?: number;
  usage?: RawUsage;
  modelUsage?: RawModelUsage;
} {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "result"
  );
}
const runSdkQuery: RunSdkQuery = (params) =>
  (async function* observe() {
    for await (const message of query(params)) {
      if (isResult(message)) {
        lastResult = {
          isError: message.is_error ?? false,
          subtype: message.subtype,
          numTurns: message.num_turns,
          usage: message.usage,
          modelUsage: message.modelUsage ?? {},
        };
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
    const error = last.error ?? {};
    const detail = `${error._tag ?? "error"}:${error.category ?? ""} ${error.message ?? ""}`;
    if (
      (error.category !== undefined && BLOCKED_CATEGORIES.has(error.category)) ||
      BLOCKED_TEXT.test(error.message ?? "")
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
  const observed = observedResult();
  const raw = observed?.usage;
  const modelUsage = observed?.modelUsage ?? {};
  const record: TurnRecord = {
    session,
    turn,
    text: events
      .filter((event) => event.type === "text_delta")
      .map((event) => event.text ?? "")
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
    numTurns: observed?.numTurns,
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
    // Turns are sequential by construction: each depends on the previous transcript.
    // oxlint-disable-next-line eslint/no-await-in-loop
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
      api: "claude-sdk",
      provider: "claude-sdk",
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

function check(passed: boolean, value: unknown, threshold: string): Check {
  return { status: passed ? "passed" : "failed", value, threshold };
}

const output: Record<string, unknown> = {
  probe: "pi-claude-sdk-cache",
  model: modelId,
  packageDir,
  nonce,
  systemPromptCharacters: systemPrompt.length,
  turns,
};
let exitCode = 0;
try {
  const sessionA = await runSession("A", 3, 0);
  const sessionB = await runSession("B", 1, 0);
  const sessionC = await runSession("C", 3, 25);
  const laterA = sessionA.slice(1);
  const checks: Record<string, Check> = {
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
