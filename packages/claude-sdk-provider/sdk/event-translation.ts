import type { BridgeEvent } from "../bridge";
import { SdkProtocolError, SdkResultError } from "./errors";

/** Result of parsing an untrusted SDK protocol value. */
export type ParseResult<T> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "err"; readonly error: SdkProtocolError };

function ok<T>(value: T): ParseResult<T> {
  return { _tag: "ok", value };
}

function err<T>(messageType: string, detail: string): ParseResult<T> {
  return { _tag: "err", error: new SdkProtocolError(messageType, detail) };
}

/** Narrow an unknown SDK value to an object record. */
export function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  // SAFETY: The checks establish a non-null, non-array object with unknown property values.
  return value as Record<string, unknown>;
}

function optionalTokenCount(
  usage: Record<string, unknown>,
  field: string,
  messageType: string,
): ParseResult<number | undefined> {
  const value = usage[field];
  if (value === undefined) return ok(undefined);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return err(messageType, `${field} must be a finite non-negative number`);
  }
  return ok(value);
}

function usageEvent(usageValue: unknown, messageType: string): ParseResult<BridgeEvent> {
  const usage = record(usageValue);
  if (!usage) return err(messageType, "usage must be an object");
  const fields = parseUsageFields(usage, messageType);
  if (fields._tag === "err") return fields;
  const { input, output, cacheRead, cacheWrite } = fields.value;
  return ok({
    type: "usage",
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  });
}

function parseUsageFields(
  usage: Record<string, unknown>,
  messageType: string,
): ParseResult<{
  readonly input: number | undefined;
  readonly output: number | undefined;
  readonly cacheRead: number | undefined;
  readonly cacheWrite: number | undefined;
}> {
  const input = optionalTokenCount(usage, "input_tokens", messageType);
  if (input._tag === "err") return input;
  const output = optionalTokenCount(usage, "output_tokens", messageType);
  if (output._tag === "err") return output;
  const cacheRead = optionalTokenCount(usage, "cache_read_input_tokens", messageType);
  if (cacheRead._tag === "err") return cacheRead;
  const cacheWrite = optionalTokenCount(usage, "cache_creation_input_tokens", messageType);
  if (cacheWrite._tag === "err") return cacheWrite;
  return ok({
    input: input.value,
    output: output.value,
    cacheRead: cacheRead.value,
    cacheWrite: cacheWrite.value,
  });
}

function contentBlockDelta(event: Record<string, unknown>): ParseResult<BridgeEvent | undefined> {
  const delta = record(event.delta);
  if (!delta || typeof delta.type !== "string") {
    return err("content_block_delta", "delta and delta.type are required");
  }
  if (delta.type === "text_delta") {
    return typeof delta.text === "string"
      ? ok({ type: "text_delta", text: delta.text })
      : err("text_delta", "text must be a string");
  }
  if (delta.type === "thinking_delta") {
    return typeof delta.thinking === "string"
      ? ok({ type: "thinking_delta", text: delta.thinking })
      : err("thinking_delta", "thinking must be a string");
  }
  return ok(undefined);
}

function streamEvent(eventValue: unknown): ParseResult<BridgeEvent | undefined> {
  const event = record(eventValue);
  if (!event || typeof event.type !== "string") {
    return err("stream event", "event and event.type are required");
  }
  if (event.type === "content_block_delta") return contentBlockDelta(event);
  if (event.type === "message_delta") return usageEvent(event.usage, "message_delta usage");
  if (event.type !== "message_start") return ok(undefined);
  const startedMessage = record(event.message);
  return startedMessage
    ? usageEvent(startedMessage.usage, "message_start usage")
    : err("message_start", "message must be an object");
}

/** Parse one SDK stream message into the provider's event language. */
export function translateSdkStreamEvent(
  messageValue: unknown,
): ParseResult<BridgeEvent | undefined> {
  const message = record(messageValue);
  if (!message) return err("message", "message must be an object");
  if (message.type === "stream_event") return streamEvent(message.event);
  if (message.type !== "assistant") return ok(undefined);
  const assistantMessage = record(message.message);
  return assistantMessage
    ? usageEvent(assistantMessage.usage, "assistant usage")
    : err("assistant message", "message must be an object");
}

/** Parsed outcome of a terminal SDK result. */
export type ResultOutcome =
  | {
      readonly _tag: "success";
      readonly stopReason: "stop" | "length";
      readonly terminalReason: string | undefined;
    }
  | { readonly _tag: "failure"; readonly error: SdkResultError }
  | { readonly _tag: "malformed"; readonly error: SdkProtocolError };

function malformedResult(detail: string): ResultOutcome {
  return { _tag: "malformed", error: new SdkProtocolError("result", detail) };
}

const SDK_STOP_REASONS: ReadonlySet<unknown> = new Set([
  undefined,
  null,
  "end_turn",
  "max_tokens",
  "model_context_window_exceeded",
  "pause_turn",
  "stop_sequence",
  "tool_deferred",
  "tool_use",
]);

/** Parse the terminal result emitted by the Claude Agent SDK. */
export function resultOutcome(message: Record<string, unknown>): ResultOutcome {
  if (typeof message.is_error !== "boolean") return malformedResult("is_error must be a boolean");
  if (
    message.stop_reason !== null &&
    message.stop_reason !== undefined &&
    typeof message.stop_reason !== "string"
  ) {
    return malformedResult("stop_reason must be a string or null");
  }
  if (!SDK_STOP_REASONS.has(message.stop_reason)) {
    return malformedResult(`unsupported stop_reason ${String(message.stop_reason)}`);
  }
  if (message.terminal_reason !== undefined && typeof message.terminal_reason !== "string") {
    return malformedResult("terminal_reason must be a string");
  }
  const stopReason =
    message.stop_reason === "max_tokens" || message.stop_reason === "model_context_window_exceeded"
      ? "length"
      : "stop";
  const reportedTerminalReason =
    typeof message.terminal_reason === "string" ? message.terminal_reason : undefined;
  const terminalReason =
    reportedTerminalReason ??
    (message.stop_reason === "tool_deferred" ? "tool_deferred" : undefined);
  if (!(message.is_error || terminalReason === "tool_deferred_unavailable")) {
    return { _tag: "success", stopReason, terminalReason };
  }
  return failedResult(message, terminalReason);
}

function failedResult(
  message: Record<string, unknown>,
  terminalReason: string | undefined,
): ResultOutcome {
  const errors = Array.isArray(message.errors)
    ? message.errors.filter((entry): entry is string => typeof entry === "string")
    : [];
  const resultText =
    typeof message.result === "string" && message.result.length > 0 ? message.result : undefined;
  const defaultMessage =
    terminalReason === "tool_deferred_unavailable"
      ? "Claude Agent SDK could not honor the deferred Pi tool call (terminal_reason: tool_deferred_unavailable)"
      : "Claude Agent SDK reported an error result";
  return {
    _tag: "failure",
    error: new SdkResultError(terminalReason, errors.join("; ") || resultText || defaultMessage),
  };
}
