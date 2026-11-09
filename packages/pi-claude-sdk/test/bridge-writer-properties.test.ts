import assert from "node:assert/strict";
import { Database, Hegel } from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { createAgentSdkStream } from "../bridge";
import type { BridgeEvent, TokenUsage } from "../bridge";
import { SdkResultError } from "../sdk/errors";
import { contextFixture, drain, sonnet } from "./fixtures";

const settings = { testCases: 200, seed: 12_345n, database: Database.disabled };
const context = contextFixture({
  systemPrompt: "s",
  messages: [{ role: "user", content: "Hello" }],
  tools: [],
});
const TERMINALS: readonly BridgeEvent[] = [
  { type: "done", reason: "stop" },
  { type: "done", reason: "length" },
  { type: "tool_calls", calls: [{ id: "c1", name: "read", arguments: {} }] },
  {
    type: "failed",
    error: new SdkResultError({ terminalReason: undefined, category: "cancelled" }),
  },
];

function tokens(tc: TestCase): number {
  return tc.draw(
    gs.oneOf(
      gs.just(0),
      gs.integers({ minValue: 0, maxValue: 50 }),
      gs.integers({ minValue: 0, maxValue: 2_000_000 }),
    ),
  );
}

function drawUsage(tc: TestCase): TokenUsage {
  const cacheWrite = tokens(tc);
  const split = tc.draw(gs.sampledFrom(["none", "all", "zero"] as const));
  const base = { input: tokens(tc), output: tokens(tc), cacheRead: tokens(tc), cacheWrite };
  return split === "none" ? base : { ...base, cacheWrite1h: split === "all" ? cacheWrite : 0 };
}

function drawEvent(tc: TestCase): BridgeEvent {
  const kind = tc.draw(gs.sampledFrom(["text_delta", "thinking_delta", "usage"] as const));
  if (kind === "usage") {
    return { type: "usage", usage: drawUsage(tc) };
  }
  return { type: kind, text: tc.draw(gs.sampledFrom(["a", "b", "", "ab"])) };
}

function deltas(events: readonly BridgeEvent[], kind: "text_delta" | "thinking_delta"): string {
  return events.flatMap((event) => (event.type === kind ? [event.text] : [])).join("");
}

function checkRun(
  before: readonly BridgeEvent[],
  terminal: BridgeEvent,
  out: Awaited<ReturnType<typeof collect>>,
): void {
  const { events, message } = out;
  const ends = events.filter((event) => event.type === "done" || event.type === "error");
  assert.equal(ends.length, 1);
  assert.equal(events.at(-1), ends[0]);
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  const thinking = message.content
    .flatMap((block) => (block.type === "thinking" ? [block.thinking] : []))
    .join("");
  assert.equal(text, deltas(before, "text_delta"));
  assert.equal(thinking, deltas(before, "thinking_delta"));
  assert.equal(message.stopReason === "toolUse", terminal.type === "tool_calls");
  const usages = before.flatMap((event) => (event.type === "usage" ? [event.usage] : []));
  const last = usages.at(-1);
  const expected = last ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.equal(message.usage.input, expected.input);
  assert.equal(message.usage.output, expected.output);
  assert.equal(message.usage.cacheRead, expected.cacheRead);
  assert.equal(message.usage.cacheWrite, expected.cacheWrite);
  assert.equal(message.usage.cacheWrite1h, last?.cacheWrite1h);
  assert.equal(
    message.usage.totalTokens,
    expected.input + expected.output + expected.cacheRead + expected.cacheWrite,
  );
}

async function collect(events: readonly BridgeEvent[]) {
  async function* run(): AsyncGenerator<BridgeEvent> {
    yield* events;
  }
  const stream = createAgentSdkStream({ model: sonnet, context, options: {}, run });
  const seen = await drain(stream);
  return { events: seen, message: await stream.result() };
}

describe("bridge writer properties", () => {
  test("one terminal event, deltas concatenate, stopReason and usage follow the last event", async () => {
    await new Hegel(async (tc) => {
      const before = tc.draw(gs.arrays(gs.composite(drawEvent), { maxSize: 8 }));
      assert.ok(before.length <= 8);
      const terminal = tc.draw(gs.sampledFrom(TERMINALS));
      const after = Array.from({ length: tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) }, () =>
        drawEvent(tc),
      );
      checkRun(before, terminal, await collect([...before, terminal, ...after]));
    })
      .databaseKey("pi-claude-sdk/bridge-writer")
      .settings(settings)
      .run();
  });
});
