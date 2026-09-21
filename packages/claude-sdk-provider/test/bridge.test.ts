import type { AssistantMessageEvent, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { type BridgeEvent, createAgentSdkStream } from "../bridge";
import { SdkResultError } from "../sdk/errors";
import { contextFixture, drain, sonnet } from "./fixtures";

const context = contextFixture({
  systemPrompt: "Be concise.",
  messages: [{ role: "user", content: "Hello" }],
  tools: [],
});

function piEvents(
  events: ReadonlyArray<BridgeEvent>,
  options: SimpleStreamOptions = {},
): Promise<AssistantMessageEvent[]> {
  const run = async function* (): AsyncGenerator<BridgeEvent> {
    yield* events;
  };
  return drain(createAgentSdkStream(sonnet, context, options, run));
}

function terminalOf(events: ReadonlyArray<AssistantMessageEvent>) {
  const terminal = events.at(-1);
  if (terminal?.type === "done") return { reason: terminal.reason, message: terminal.message };
  if (terminal?.type === "error") return { reason: terminal.reason, message: terminal.error };
  throw new Error("test setup: stream did not end with a terminal event");
}

describe("provider event streaming", () => {
  test("streams SDK text and usage through Pi's provider event contract", async () => {
    const events = await piEvents([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " from Claude" },
      { type: "usage", usage: { input: 12, output: 0, cacheRead: 4, cacheWrite: 0 } },
      { type: "usage", usage: { input: 12, output: 3, cacheRead: 4, cacheWrite: 0 } },
      { type: "done", reason: "stop" },
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    const { reason, message } = terminalOf(events);
    expect(reason).toBe("stop");
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([{ type: "text", text: "Hello from Claude" }]);
    expect(message.usage).toMatchObject({ input: 12, output: 3, cacheRead: 4, totalTokens: 19 });
  });

  test("streams thinking and text as distinct content blocks, one open at a time", async () => {
    const events = await piEvents([
      { type: "thinking_delta", text: "Let me " },
      { type: "thinking_delta", text: "think." },
      { type: "text_delta", text: "Answer." },
      { type: "thinking_delta", text: "More." },
      { type: "done", reason: "stop" },
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "done",
    ]);
    expect(
      events.flatMap((event) => ("contentIndex" in event ? [event.contentIndex] : [])),
    ).toEqual([0, 0, 0, 0, 1, 1, 1, 2, 2, 2]);
    expect(events[4]).toMatchObject({ type: "thinking_end", content: "Let me think." });
    expect(terminalOf(events).message.content).toEqual([
      { type: "thinking", thinking: "Let me think." },
      { type: "text", text: "Answer." },
      { type: "thinking", thinking: "More." },
    ]);
  });

  test("ends the Pi turn with every deferred tool call the model batched, after any text", async () => {
    const events = await piEvents([
      { type: "text_delta", text: "Reading both." },
      {
        type: "tool_calls",
        calls: [
          { id: "tool-1", name: "read", arguments: { path: "package.json" } },
          { id: "tool-2", name: "read", arguments: { path: "README.md" } },
        ],
      },
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_end",
      "toolcall_start",
      "toolcall_end",
      "done",
    ]);
    const { reason, message } = terminalOf(events);
    expect(reason).toBe("toolUse");
    expect(message.stopReason).toBe("toolUse");
    expect(message.content).toEqual([
      { type: "text", text: "Reading both." },
      { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "package.json" } },
      { type: "toolCall", id: "tool-2", name: "read", arguments: { path: "README.md" } },
    ]);
  });

  test("reports a length stop reason when the SDK ends the turn at max_tokens", async () => {
    const events = await piEvents([
      { type: "text_delta", text: "Truncated" },
      { type: "done", reason: "length" },
    ]);

    expect(terminalOf(events).reason).toBe("length");
  });
});

describe("provider failures", () => {
  test("surfaces a failed turn as one categorized Pi error that keeps the partial content", async () => {
    const events = await piEvents([
      { type: "text_delta", text: "Partial" },
      { type: "failed", error: new SdkResultError(undefined, "You're out of extra usage") },
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "error",
    ]);
    const { reason, message } = terminalOf(events);
    expect(reason).toBe("error");
    expect(message.content).toEqual([{ type: "text", text: "Partial" }]);
    expect(message.errorMessage).toBe("Claude SDK [usage-limit]: You're out of extra usage");
  });

  test("reports a failure after cancellation as aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const events = await piEvents(
      [{ type: "failed", error: new SdkResultError(undefined, "interrupted") }],
      { signal: controller.signal },
    );

    expect(terminalOf(events).reason).toBe("aborted");
  });

  test("fails when the run ends without a terminal event", async () => {
    const events = await piEvents([{ type: "text_delta", text: "Truncated" }]);

    const { reason, message } = terminalOf(events);
    expect(reason).toBe("error");
    expect(message.content).toEqual([{ type: "text", text: "Truncated" }]);
    expect(message.errorMessage).toContain("terminal-result");
  });

  test("ignores events after the terminal event", async () => {
    const events = await piEvents([
      { type: "done", reason: "stop" },
      { type: "text_delta", text: "late" },
    ]);

    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
  });

  test("turns an unexpected rejection from the run into a Pi error instead of an unhandled one", async () => {
    const run = async function* (): AsyncGenerator<BridgeEvent> {
      yield { type: "text_delta", text: "Partial" };
      throw new Error("adapter defect");
    };

    const events = await drain(createAgentSdkStream(sonnet, context, {}, run));

    const { reason, message } = terminalOf(events);
    expect(reason).toBe("error");
    expect(message.errorMessage).toContain("adapter defect");
  });
});
