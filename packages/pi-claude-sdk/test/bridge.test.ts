import process from "node:process";
import type {
  AssistantMessageEvent,
  AssistantMessageEventStream,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createAgentSdkStream } from "../bridge";
import type { BridgeEvent } from "../bridge";
import { SdkResultError } from "../sdk/errors";
import { contextFixture, drain, sonnet } from "./fixtures";

const context = contextFixture({
  systemPrompt: "Be concise.",
  messages: [{ role: "user", content: "Hello" }],
  tools: [],
});

async function piEvents(
  events: readonly BridgeEvent[],
  options: SimpleStreamOptions = {},
): Promise<AssistantMessageEvent[]> {
  async function* run(): AsyncGenerator<BridgeEvent> {
    yield* events;
  }
  return drain(createAgentSdkStream({ model: sonnet, context, options, run }));
}

async function* failingRun(): AsyncGenerator<BridgeEvent> {
  yield { type: "text_delta", text: "Partial" };
  throw new Error("adapter defect");
}

/** Make Pi's stream throw when the writer pushes one terminal event type. */
function breakTerminalPush(stream: AssistantMessageEventStream, type: "done" | "error"): void {
  const push = stream.push.bind(stream);
  vi.spyOn(stream, "push").mockImplementation((event: AssistantMessageEvent) => {
    if (event.type === type) {
      throw new Error("finalization defect");
    }
    push(event);
  });
}

function streamOf(event: BridgeEvent): AssistantMessageEventStream {
  async function* run(): AsyncGenerator<BridgeEvent> {
    yield event;
  }
  return createAgentSdkStream({ model: sonnet, context, options: {}, run });
}

function contentIndexes(events: readonly AssistantMessageEvent[]): number[] {
  return events.flatMap((event) => ("contentIndex" in event ? [event.contentIndex] : []));
}

function terminalOf(events: readonly AssistantMessageEvent[]) {
  const terminal = events.at(-1);
  if (terminal?.type === "done") {
    return { reason: terminal.reason, message: terminal.message };
  }
  if (terminal?.type === "error") {
    return { reason: terminal.reason, message: terminal.error };
  }
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

    expect(events.map((event) => event.type)).toStrictEqual([
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
    expect(message.content).toStrictEqual([{ type: "text", text: "Hello from Claude" }]);
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

    expect(events.map((event) => event.type)).toStrictEqual([
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
    expect(contentIndexes(events)).toStrictEqual([0, 0, 0, 0, 1, 1, 1, 2, 2, 2]);
    expect(events[4]).toMatchObject({ type: "thinking_end", content: "Let me think." });
    expect(terminalOf(events).message.content).toStrictEqual([
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

    expect(events.map((event) => event.type)).toStrictEqual([
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
    expect(message.content).toStrictEqual([
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
      {
        type: "failed",
        error: new SdkResultError({
          terminalReason: undefined,
          category: "usage-limit",
        }),
      },
    ]);

    expect(events.map((event) => event.type)).toStrictEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "error",
    ]);
    const { reason, message } = terminalOf(events);
    expect(reason).toBe("error");
    expect(message.content).toStrictEqual([{ type: "text", text: "Partial" }]);
    expect(message.errorMessage).toBe(
      "Claude Agent SDK: Claude usage limit reached; check subscription allowance",
    );
  });

  test("reports a failure after cancellation as aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const events = await piEvents(
      [
        {
          type: "failed",
          error: new SdkResultError({ terminalReason: undefined, category: "cancelled" }),
        },
      ],
      { signal: controller.signal },
    );

    expect(terminalOf(events).reason).toBe("aborted");
  });

  test("fails when the run ends without a terminal event", async () => {
    const events = await piEvents([{ type: "text_delta", text: "Truncated" }]);

    const { reason, message } = terminalOf(events);
    expect(reason).toBe("error");
    expect(message.content).toStrictEqual([{ type: "text", text: "Truncated" }]);
    expect(message.errorMessage).toBe(
      "Claude SDK provider bug: the turn ended without a final result",
    );
  });

  test("ignores events after the terminal event", async () => {
    const events = await piEvents([
      { type: "done", reason: "stop" },
      { type: "text_delta", text: "late" },
    ]);

    expect(events.map((event) => event.type)).toStrictEqual(["start", "done"]);
  });

  test("turns an unexpected rejection from the run into a Pi error instead of an unhandled one", async () => {
    const events = await drain(
      createAgentSdkStream({ model: sonnet, context, options: {}, run: failingRun }),
    );

    const { reason, message } = terminalOf(events);
    expect(reason).toBe("error");
    expect(message.errorMessage).toBe(
      "Claude SDK provider bug: the SDK runner failed unexpectedly",
    );
    expect(message.errorMessage).not.toContain("adapter defect");
  });
});

describe("broken stderr", () => {
  const stderr = process.stderr;
  const ttyDescriptor = Object.getOwnPropertyDescriptor(stderr, "isTTY");

  afterEach(() => {
    vi.restoreAllMocks();
    if (ttyDescriptor === undefined) {
      Reflect.deleteProperty(stderr, "isTTY");
    } else {
      Object.defineProperty(stderr, "isTTY", ttyDescriptor);
    }
  });

  async function drainWithBrokenStderr(run: () => AsyncIterable<BridgeEvent>) {
    Object.defineProperty(stderr, "isTTY", { configurable: true, value: false });
    vi.spyOn(stderr, "write").mockImplementation(() => {
      throw new Error("EPIPE");
    });
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const events = await drain(
        createAgentSdkStream({ model: sonnet, context, options: {}, run }),
      );
      // Node reports unhandled rejections after microtasks drain; two macrotask turns
      // deterministically cover that, without a wall-clock wait.
      for (let turn = 0; turn < 2; turn += 1) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      return { events, unhandled };
    } finally {
      process.off("unhandledRejection", listener);
    }
  }

  test("a failed event still ends the stream with an error", async () => {
    const { events, unhandled } = await drainWithBrokenStderr(async function* run() {
      yield {
        type: "failed",
        error: new SdkResultError({ terminalReason: undefined, category: "usage-limit" }),
      };
    });
    expect(terminalOf(events).reason).toBe("error");
    expect(unhandled).toStrictEqual([]);
  });

  test("a rejecting run still ends the stream with an error", async () => {
    const { events, unhandled } = await drainWithBrokenStderr(failingRun);
    expect(terminalOf(events).reason).toBe("error");
    expect(unhandled).toStrictEqual([]);
  });

  test("a run that throws synchronously still ends the stream with an error", async () => {
    const { events, unhandled } = await drainWithBrokenStderr(() => {
      throw new Error("sync defect");
    });
    expect(terminalOf(events).reason).toBe("error");
    expect(unhandled).toStrictEqual([]);
  });

  test("a throw while pushing the error event still ends the stream and settles its result", async () => {
    const stream = streamOf({
      type: "failed",
      error: new SdkResultError({ terminalReason: undefined, category: "usage-limit" }),
    });
    breakTerminalPush(stream, "error");
    const events = await drain(stream);
    expect(events.map((item) => item.type)).toStrictEqual(["start"]);
    await expect(stream.result()).resolves.toMatchObject({ stopReason: "error" });
  });

  test("a throw while pushing the done event still ends the stream and settles its result", async () => {
    const stream = streamOf({ type: "done", reason: "stop" });
    breakTerminalPush(stream, "done");
    const events = await drain(stream);
    expect(events.map((item) => item.type)).toStrictEqual(["start"]);
    await expect(stream.result()).resolves.toMatchObject({ stopReason: "stop" });
  });

  test("a done then a failed produces a single terminal event", async () => {
    const events = await piEvents([
      { type: "done", reason: "stop" },
      {
        type: "failed",
        error: new SdkResultError({ terminalReason: undefined, category: "usage-limit" }),
      },
      { type: "text_delta", text: "late" },
    ]);
    expect(events.map((event) => event.type)).toStrictEqual(["start", "done"]);
  });
});

describe("cache usage", () => {
  test("clears an earlier 1h split when authoritative usage no longer supplies it", async () => {
    const events = await piEvents([
      {
        type: "usage",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 3, cacheWrite1h: 3 },
      },
      { type: "usage", usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 10 } },
      { type: "done", reason: "stop" },
    ]);

    const { message } = terminalOf(events);
    expect(message.usage).toMatchObject({ cacheWrite: 10, totalTokens: 14 });
    expect(message.usage).not.toHaveProperty("cacheWrite1h");
  });

  test("forwards the 1h cache-write split to Pi usage without the 5m diagnostic field", async () => {
    const events = await piEvents([
      {
        type: "usage",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 5,
          cacheWrite1h: 5,
          cacheWrite5m: 0,
        },
      },
      { type: "done", reason: "stop" },
    ]);

    const { message } = terminalOf(events);
    expect(message.usage).toMatchObject({ cacheWrite: 5, cacheWrite1h: 5, totalTokens: 7 });
    expect(message.usage).not.toHaveProperty("cacheWrite5m");
  });
});
