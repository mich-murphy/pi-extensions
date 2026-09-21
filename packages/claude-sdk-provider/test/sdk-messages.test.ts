import { describe, expect, test } from "vitest";
import { SdkProtocolError } from "../sdk/errors";
import { applyUsage, contextWindowFor, parseSdkMessage, type SdkMessage } from "../sdk/messages";
import { resultMessage, streamEvent, textDelta } from "./fixtures";

function parsed(input: unknown): SdkMessage {
  const result = parseSdkMessage(input);
  if (result._tag === "err") throw result.error;
  return result.value;
}

function protocolError(input: unknown): SdkProtocolError {
  const result = parseSdkMessage(input);
  if (result._tag === "ok") throw new Error("test setup: expected a protocol error");
  expect(result.error).toBeInstanceOf(SdkProtocolError);
  expect(result.error._tag).toBe("SdkProtocolError");
  return result.error;
}

function turnResult(fields: Record<string, unknown>) {
  const message = parsed(resultMessage(fields));
  if (message.type !== "result") throw new Error("test setup: expected a result message");
  return message.result;
}

const usage = {
  input_tokens: 10,
  output_tokens: 2,
  cache_read_input_tokens: 3,
  cache_creation_input_tokens: 1,
};

describe("SDK stream messages", () => {
  test("translates official Agent SDK stream events without depending on private endpoints", () => {
    expect(parsed(textDelta("Hi"))).toEqual({ type: "text_delta", text: "Hi" });
    expect(
      parsed(
        streamEvent({
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "Hmm" },
        }),
      ),
    ).toEqual({ type: "thinking_delta", text: "Hmm" });
    expect(
      parsed(streamEvent({ type: "message_delta", delta: { stop_reason: null }, usage })),
    ).toEqual({ type: "usage", usage });
  });

  test("reads the main-loop model and usage from message_start and assistant messages", () => {
    const message = { model: "claude-fable-5-1", usage };

    expect(parsed(streamEvent({ type: "message_start", message }))).toEqual({
      type: "usage",
      model: "claude-fable-5-1",
      usage,
    });
    expect(parsed({ type: "assistant", message })).toEqual({
      type: "usage",
      model: "claude-fable-5-1",
      usage,
    });
  });

  test("treats a missing or non-string model as unobserved without failing the turn", () => {
    expect(parsed({ type: "assistant", message: { usage } })).toEqual({ type: "usage", usage });
    expect(parsed({ type: "assistant", message: { model: 42, usage } })).toEqual({
      type: "usage",
      usage,
    });
    expect(parsed({ type: "assistant", message: { model: "", usage } })).toEqual({
      type: "usage",
      usage,
    });
  });

  test.each([
    ["a message type", { type: "system", subtype: "init" }],
    ["a user message", { type: "user" }],
    ["a stream event type", streamEvent({ type: "content_block_stop", index: 0 })],
    [
      "a content delta type",
      streamEvent({
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: "{" },
      }),
    ],
    ["a stream event without a type", streamEvent({})],
    ["an Object.prototype key used as a type", { type: "constructor" }],
  ])("ignores %s this provider does not consume", (_case, input) => {
    expect(parsed(input)).toEqual({ type: "ignored" });
  });

  test.each([
    ["a non-object message", 5, "message"],
    ["a message without a type", { event: {} }, "message"],
    [
      "non-numeric usage, instead of reporting invented zero counts",
      streamEvent({ type: "message_delta", usage: { output_tokens: "two" } }),
      "stream_event.message_delta",
    ],
    [
      "negative usage",
      streamEvent({ type: "message_delta", usage: { output_tokens: -1 } }),
      "stream_event.message_delta",
    ],
    [
      "infinite usage",
      streamEvent({ type: "message_delta", usage: { output_tokens: Number.POSITIVE_INFINITY } }),
      "stream_event.message_delta",
    ],
    ["missing usage", { type: "assistant", message: {} }, "assistant"],
    [
      "a non-string text delta",
      streamEvent({ type: "content_block_delta", delta: { type: "text_delta", text: 4 } }),
      "stream_event.content_block_delta.text_delta",
    ],
    ["a result without is_error", { type: "result", stop_reason: "end_turn" }, "result"],
    ["a non-string stop_reason", resultMessage({ stop_reason: 7 }), "result"],
    ["a non-string terminal_reason", resultMessage({ terminal_reason: 7 }), "result"],
  ])("rejects %s", (_case, input, messageType) => {
    expect(protocolError(input).messageType).toBe(messageType);
  });

  test("names the offending field without echoing its value", () => {
    const error = protocolError(
      streamEvent({ type: "message_delta", usage: { output_tokens: "secret-value" } }),
    );

    expect(error.message).toContain("event.usage.output_tokens");
    expect(error.message).not.toContain("secret-value");
  });
});

describe("usage accumulation", () => {
  test("replaces each reported count and keeps the rest, treating null like an omitted count", () => {
    const started = applyUsage(undefined, { input_tokens: 12, cache_read_input_tokens: 4 });
    expect(started).toEqual({ input: 12, output: 0, cacheRead: 4, cacheWrite: 0 });

    const finished = applyUsage(started, {
      input_tokens: null,
      output_tokens: 3,
      cache_creation_input_tokens: null,
    });
    expect(finished).toEqual({ input: 12, output: 3, cacheRead: 4, cacheWrite: 0 });
  });

  test("accepts the null counts the API sends on message_delta", () => {
    const message = parsed(
      streamEvent({ type: "message_delta", usage: { input_tokens: null, output_tokens: 9 } }),
    );

    expect(message).toEqual({ type: "usage", usage: { input_tokens: null, output_tokens: 9 } });
  });
});

describe("terminal SDK result", () => {
  test.each([
    ["end_turn", "stop", undefined],
    [null, "stop", undefined],
    ["pause_turn", "stop", undefined],
    ["stop_sequence", "stop", undefined],
    ["tool_use", "stop", undefined],
    ["max_tokens", "length", undefined],
    ["model_context_window_exceeded", "length", undefined],
    ["tool_deferred", "stop", "tool_deferred"],
  ])("maps stop_reason %s to %s", (stopReason, expected, terminalReason) => {
    expect(turnResult({ stop_reason: stopReason })).toEqual({
      _tag: "completed",
      stopReason: expected,
      terminalReason,
    });
  });

  test("prefers the reported terminal_reason over the one implied by stop_reason", () => {
    expect(turnResult({ stop_reason: null, terminal_reason: "tool_deferred" })).toMatchObject({
      terminalReason: "tool_deferred",
    });
    expect(turnResult({ terminal_reason: "completed" })).toMatchObject({
      terminalReason: "completed",
    });
  });

  test("rejects unknown SDK stop reasons on an otherwise clean result", () => {
    const error = protocolError(resultMessage({ stop_reason: "future_reason" }));

    expect(error.message).toContain("unsupported stop_reason future_reason");
  });

  test("surfaces the SDK's own error result instead of silently reporting an empty stop", () => {
    const failure = (fields: Record<string, unknown>) => {
      const result = turnResult({ is_error: true, stop_reason: null, ...fields });
      if (result._tag !== "failed") throw new Error("test setup: expected a failed result");
      return result.error;
    };

    expect(failure({ errors: ["context deadline exceeded", 7, "retry later"] }).message).toBe(
      "context deadline exceeded; retry later",
    );
    expect(failure({ result: "The model refused to respond." }).message).toBe(
      "The model refused to respond.",
    );
    expect(failure({}).message).toBe("Claude Agent SDK reported an error result");
    expect(failure({ terminal_reason: "model_error" }).terminalReason).toBe("model_error");
  });

  test("reports an error result as the SDK's failure even when its stop reason is unknown", () => {
    const result = turnResult({
      is_error: true,
      stop_reason: "future_reason",
      errors: ["upstream failed"],
    });

    expect(result).toMatchObject({ _tag: "failed", error: { message: "upstream failed" } });
  });

  test("treats terminal_reason tool_deferred_unavailable as an error even when is_error is false", () => {
    const result = turnResult({ stop_reason: null, terminal_reason: "tool_deferred_unavailable" });

    expect(result).toMatchObject({
      _tag: "failed",
      error: {
        _tag: "SdkResultError",
        terminalReason: "tool_deferred_unavailable",
        message:
          "Claude Agent SDK could not honor the deferred Pi tool call (terminal_reason: tool_deferred_unavailable)",
      },
    });
  });

  test("treats a model refusal as a failure, like Pi's Anthropic provider", () => {
    expect(turnResult({ stop_reason: "refusal" })).toMatchObject({
      _tag: "failed",
      error: { message: "The model refused to complete the request" },
    });
  });
});

describe("contextWindowFor", () => {
  const message = parsed(
    resultMessage({
      modelUsage: {
        "claude-haiku-4-5-20251001": { canonicalModel: "claude-haiku-4-5", contextWindow: 200_000 },
        "claude-fable-5-1": { canonicalModel: "claude-fable-5-1", contextWindow: 1_000_000 },
      },
    }),
  );
  if (message.type !== "result") throw new Error("test setup: expected a result message");
  const { modelUsage } = message;

  test("matches an entry by key or canonical model", () => {
    expect(contextWindowFor(modelUsage, "claude-fable-5-1")).toBe(1_000_000);
    expect(contextWindowFor(modelUsage, "claude-haiku-4-5-20251001")).toBe(200_000);
  });

  test("matches a dated entry through its canonical model", () => {
    expect(contextWindowFor(modelUsage, "claude-haiku-4-5")).toBe(200_000);
  });

  test("returns undefined for unknown models", () => {
    expect(contextWindowFor(modelUsage, "claude-opus-5")).toBeUndefined();
  });

  test.each([
    ["a zero window", { "claude-fable-5-1": { contextWindow: 0 } }],
    ["a malformed entry", { "claude-fable-5-1": "nope" }],
    ["malformed model usage", "nope"],
    ["missing model usage", undefined],
  ])("reports no window for %s without failing the result", (_case, reported) => {
    const result = parsed(resultMessage({ modelUsage: reported }));
    if (result.type !== "result") throw new Error("test setup: expected a result message");

    expect(result.result._tag).toBe("completed");
    expect(contextWindowFor(result.modelUsage, "claude-fable-5-1")).toBeUndefined();
  });
});
