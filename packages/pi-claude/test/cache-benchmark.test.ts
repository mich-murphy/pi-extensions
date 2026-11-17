import type { CacheRetention, SystemMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { buildAgentRequest } from "../agent-request";
import type { AgentRequest } from "../agent-request";
import { cacheTtlFor } from "../sdk/prompt-stream";
import { createCacheSimulator, estimateTextTokens, readShare } from "./cache-simulator";
import type { CacheUsage } from "./cache-simulator";
import { contextFixture, requestFixture, textBlock } from "./fixtures";
import type { MessageFixture } from "./fixtures";

const MINUTE_MS = 60_000;
const TURN_GAP_MS = 30_000;

/** About 6k tokens of deterministic Pi working instructions. */
const SYSTEM_PROMPT = Array.from(
  { length: 240 },
  (_, index) =>
    `Rule ${String(index).padStart(3, "0")}: keep the repository consistent, explain each change, and run the checks before finishing.`,
).join("\n");

const readTool = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

/** One request: the messages appended before it is sent, and the assistant reply after it. */
type Step = {
  readonly input: readonly MessageFixture[];
  readonly reply: MessageFixture;
  /** Milliseconds since the previous request. */
  readonly gapMs?: number;
  /** Start from an empty history (compaction, a new session) instead of appending. */
  readonly reset?: boolean;
};

type Run = { readonly request: AgentRequest; readonly usage: CacheUsage };

function prose(label: string, chars: number): string {
  return `${label}: ${"detail ".repeat(Math.ceil(chars / 7))}`.slice(0, chars);
}

function user(text: string): MessageFixture {
  return { role: "user", content: text };
}

function toolCall(id: string) {
  return { type: "toolCall" as const, id, name: "read", arguments: { path: `src/${id}.ts` } };
}

function toolResult(id: string, chars: number): MessageFixture {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    isError: false,
    content: [{ type: "text", text: prose(`Contents of ${id}`, chars) }],
  };
}

function systemUpdate(fields: Partial<SystemMessage>): MessageFixture {
  return { role: "system", content: "", ...fields };
}

function chatStep(turn: number, extra: Partial<Step> = {}): Step {
  return {
    input: [user(prose(`Question ${turn}`, 400))],
    reply: { role: "assistant", content: [{ type: "text", text: prose(`Answer ${turn}`, 1600) }] },
    ...extra,
  };
}

function steadyChat(turns: number, first = 1): Step[] {
  return Array.from({ length: turns }, (_, index) => chatStep(first + index));
}

function withInputAt(steps: readonly Step[], at: number, message: MessageFixture): Step[] {
  return steps.map((step, index) =>
    index === at ? { ...step, input: [message, ...step.input] } : step,
  );
}

function toolLoop(steps: number): Step[] {
  return Array.from({ length: steps }, (_, index) => ({
    input: index === 0 ? [user("Read the sources")] : [toolResult(`call-${index - 1}`, 1200)],
    reply: { role: "assistant", content: [toolCall(`call-${index}`)] },
  }));
}

function fanOut(turns: number, width: number): Step[] {
  const callIds = (turn: number) =>
    Array.from({ length: width }, (_, index) => `turn-${turn}-call-${index}`);
  return Array.from({ length: turns }, (_, turn) => ({
    input:
      turn === 0 ? [user("Read every module")] : callIds(turn - 1).map((id) => toolResult(id, 400)),
    reply: { role: "assistant", content: callIds(turn).map((id) => toolCall(id)) },
  }));
}

const imageMessage: MessageFixture = {
  role: "user",
  content: [
    { type: "text", text: "What does this screenshot show?" },
    { type: "image", data: "c2NyZWVuc2hvdA==", mimeType: "image/png" },
  ],
};

function requestsFor(steps: readonly Step[]) {
  let history: MessageFixture[] = [];
  return steps.map((step) => {
    const messages = [...(step.reset === true ? [] : history), ...step.input];
    history = [...messages, step.reply];
    const context = contextFixture({ systemPrompt: SYSTEM_PROMPT, tools: [readTool], messages });
    return { request: buildAgentRequest(context), gapMs: step.gapMs ?? TURN_GAP_MS };
  });
}

/** Send every step's request through one shared cache, as one Pi process would. */
async function simulate(steps: readonly Step[], retention?: CacheRetention): Promise<Run[]> {
  let now = 0;
  const simulator = createCacheSimulator(() => now);
  const runs: Run[] = [];
  for (const { request, gapMs } of requestsFor(steps)) {
    now += gapMs;
    runs.push({ request, usage: await simulator.send(request, cacheTtlFor(retention)) });
  }
  return runs;
}

function runAt(runs: readonly Run[], index: number): Run {
  const run = runs[index];
  if (run === undefined) {
    throw new RangeError(`test setup: scenario has no request ${index}`);
  }
  return run;
}

function usageAt(runs: readonly Run[], index: number): CacheUsage {
  return runAt(runs, index).usage;
}

function shares(runs: readonly Run[]): number[] {
  return runs.map(({ usage }) => readShare(usage));
}

function aggregateShare(runs: readonly Run[]): number {
  return readShare({
    read: runs.reduce((total, { usage }) => total + usage.read, 0),
    write: runs.reduce((total, { usage }) => total + usage.write, 0),
    uncached: runs.reduce((total, { usage }) => total + usage.uncached, 0),
  });
}

/** Tokens of the tools, system prompt and preamble block every session shares. */
function preambleTokens({ request }: Run): number {
  return [request.toolDescription, request.systemPrompt, request.promptBlocks[0]?.text ?? ""]
    .map((text) => estimateTextTokens(text))
    .reduce((total, tokens) => total + tokens, 0);
}

/** Tokens of the transcript entries a request appended to the previous one. */
function appendedTokens(previous: Run, current: Run): number {
  return current.request.promptBlocks
    .slice(previous.request.promptBlocks.length - 1, -1)
    .map((block) => estimateTextTokens(block.text))
    .reduce((total, tokens) => total + tokens, 0);
}

const scenarios = {
  steadyChat: async () => simulate(steadyChat(10)),
  toolLoop: async () => simulate(toolLoop(10)),
  fanOut: async () => simulate(fanOut(3, 25)),
  systemChange: async () =>
    simulate(
      withInputAt(steadyChat(8), 4, systemUpdate({ sections: { rules: "<rules>new</rules>" } })),
    ),
  toolAdded: async () =>
    simulate(
      withInputAt(
        steadyChat(8),
        4,
        systemUpdate({ toolsAdded: [{ ...readTool, name: "grep", description: "Search" }] }),
      ),
    ),
  newSession: async () => simulate([...steadyChat(3), chatStep(10, { reset: true }), chatStep(11)]),
  compaction: async () =>
    simulate([
      ...steadyChat(6),
      { ...chatStep(7, { reset: true }), input: [user(prose("Summary", 2000)), user("Go on")] },
      chatStep(8),
    ]),
  images: async () => simulate(withInputAt(steadyChat(6), 2, imageMessage)),
  expiredLong: async () =>
    simulate([...steadyChat(3), chatStep(4, { gapMs: 61 * MINUTE_MS })], "long"),
  expiredDefault: async () => simulate([...steadyChat(3), chatStep(4, { gapMs: 6 * MINUTE_MS })]),
  expiredShort: async () =>
    simulate([...steadyChat(3), chatStep(4, { gapMs: 6 * MINUTE_MS })], "short"),
  noCaching: async () => simulate(steadyChat(4), "none"),
};

describe("synthetic prompt-cache benchmark", () => {
  test("steady chat reads at least 90% of every turn after the first", async () => {
    const runs = await scenarios.steadyChat();
    expect(Math.min(...shares(runs).slice(1))).toBeGreaterThanOrEqual(0.9);
  });

  test("a tool loop reads at least 85% of every step after the first", async () => {
    const runs = await scenarios.toolLoop();
    expect(Math.min(...shares(runs).slice(1))).toBeGreaterThanOrEqual(0.85);
  });

  test("a 25-way fan-out reads the earlier conversation and writes only the new suffix", async () => {
    const runs = await scenarios.fanOut();
    expect(readShare(usageAt(runs, 2))).toBeGreaterThanOrEqual(0.65);
    expect(usageAt(runs, 2).write).toBeGreaterThan(0);
    expect(usageAt(runs, 2).write).toBeLessThanOrEqual(
      appendedTokens(runAt(runs, 1), runAt(runs, 2)),
    );
  });

  test.each([
    ["systemChange", scenarios.systemChange],
    ["toolAdded", scenarios.toolAdded],
  ] as const)(
    "%s mid-session rewrites the prefix once, then every later turn reads at least 90%",
    async (_name, scenario) => {
      const runs = await scenario();
      // The preamble and catalog reflect Pi's current state, so the change turn is a full write.
      expect(Math.min(...shares(runs).slice(1, 4))).toBeGreaterThanOrEqual(0.9);
      expect(usageAt(runs, 4).read).toBe(0);
      expect(usageAt(runs, 4).write).toBeGreaterThan(0);
      expect(Math.min(...shares(runs).slice(5))).toBeGreaterThanOrEqual(0.9);
    },
  );

  test("a new session with the same prompt reads the shared preamble on its first turn", async () => {
    const runs = await scenarios.newSession();
    expect(usageAt(runs, 3).read).toBeGreaterThanOrEqual(preambleTokens(runAt(runs, 3)));
    expect(readShare(usageAt(runs, 4))).toBeGreaterThanOrEqual(0.9);
  });

  test("the first turn after compaction reads the preamble and the next reads the summary", async () => {
    const runs = await scenarios.compaction();
    expect(usageAt(runs, 6).read).toBeGreaterThanOrEqual(preambleTokens(runAt(runs, 6)));
    expect(readShare(usageAt(runs, 7))).toBeGreaterThanOrEqual(0.9);
  });

  test("an image turn is written once and read on every later turn", async () => {
    const runs = await scenarios.images();
    expect(Math.min(...shares(runs).slice(1))).toBeGreaterThanOrEqual(0.75);
    expect(Math.min(...shares(runs).slice(3))).toBeGreaterThanOrEqual(0.9);
  });

  test.each([
    ["expiredLong", scenarios.expiredLong],
    ["expiredShort", scenarios.expiredShort],
    ["expiredDefault", scenarios.expiredDefault],
  ] as const)("%s reads nothing after a gap longer than the TTL", async (_name, scenario) => {
    const runs = await scenario();
    expect(readShare(usageAt(runs, 2))).toBeGreaterThanOrEqual(0.9);
    expect(usageAt(runs, 3).read).toBe(0);
    expect(usageAt(runs, 3).write).toBeGreaterThan(0);
  });

  test("cacheRetention none neither reads nor writes", async () => {
    const runs = await scenarios.noCaching();
    expect(runs.map(({ usage }) => usage.read + usage.write)).toStrictEqual([0, 0, 0, 0]);
  });

  test.each([
    ["steadyChat", 0.85],
    ["toolLoop", 0.85],
    ["fanOut", 0.5],
    ["systemChange", 0.7],
    ["toolAdded", 0.7],
    ["newSession", 0.7],
    ["compaction", 0.8],
    ["images", 0.75],
    ["expiredLong", 0.4],
    ["expiredShort", 0.4],
    ["expiredDefault", 0.4],
    ["noCaching", 0],
  ] as const)("regression: %s aggregate read share stays at least %s", async (name, minimum) => {
    const share = aggregateShare(await scenarios[name]());
    expect(share).toBeGreaterThanOrEqual(minimum);
    expect(share).toBeLessThan(1);
  });
});

const bigBlock = textBlock("x".repeat(8000));

function handRequest(count: number, cacheBreakpoints: readonly number[]): AgentRequest {
  const entries = Array.from({ length: count - 1 }, (_, index) => textBlock(`entry ${index}`));
  return requestFixture({ promptBlocks: [bigBlock, ...entries], cacheBreakpoints });
}

function clockedSimulator() {
  const clock = { now: 0 };
  return { clock, simulator: createCacheSimulator(() => clock.now) };
}

/** Send one request at each minute mark, returning the tokens each read. */
async function readsAt(
  clock: { now: number },
  simulator: ReturnType<typeof createCacheSimulator>,
  request: AgentRequest,
  minutes: readonly number[],
): Promise<number[]> {
  const reads: number[] = [];
  for (const minute of minutes) {
    clock.now = minute * MINUTE_MS;
    const usage = await simulator.send(request, "5m");
    reads.push(usage.read);
  }
  return reads;
}

describe("cache simulator", () => {
  test.each([
    [24, 1],
    [25, 0],
  ])(
    "a breakpoint at block %i reads an entry 20 wire blocks back only within the lookback (hit %i)",
    async (breakpoint, hit) => {
      const { simulator } = clockedSimulator();
      const first = await simulator.send(handRequest(30, [5]), "1h");
      const second = await simulator.send(handRequest(30, [breakpoint]), "1h");
      expect(first.read).toBe(0);
      expect(first.write).toBeGreaterThan(1024);
      expect(second.read).toBe(first.write * hit);
    },
  );

  test("accepts four breakpoints, rejects a fifth, and reads the longest hit over all of them", async () => {
    const { simulator } = clockedSimulator();
    const first = await simulator.send(handRequest(30, [0, 10, 20, 29]), "1h");
    expect(first).toStrictEqual({ read: 0, write: first.write, uncached: 0 });
    await expect(simulator.send(handRequest(31, [0, 5, 10, 20, 30]), "1h")).rejects.toThrow(
      RangeError,
    );
    const second = await simulator.send(handRequest(31, [0, 10, 20, 30]), "1h");
    expect(second).toStrictEqual({
      read: first.write,
      write: estimateTextTokens("entry 29"),
      uncached: 0,
    });
  });

  test("stores nothing below the minimum cacheable prefix", async () => {
    const { simulator } = clockedSimulator();
    const small = requestFixture({ promptBlocks: [textBlock("hi")], cacheBreakpoints: [0] });
    await simulator.send(small, "1h");
    const usage = await simulator.send(small, "1h");
    expect(usage).toStrictEqual({ read: 0, write: 0, uncached: usage.uncached });
  });

  test("a hit refreshes the TTL, an expired entry misses, and a tools change misses", async () => {
    const { clock, simulator } = clockedSimulator();
    const request = handRequest(3, [1]);
    const reads = await readsAt(clock, simulator, request, [0, 4, 8, 14]);
    const [, written] = reads;
    expect(written).toBeGreaterThan(1024);
    expect(reads).toStrictEqual([0, written, written, 0]);
    const retooled = await simulator.send({ ...request, toolDescription: "other tools" }, "5m");
    expect(retooled.read).toBe(0);
  });
});
