import { Option, Result, Schema, SchemaIssue } from "effect";
import type { TokenUsage } from "../bridge";
import { undatedModelId } from "../models";
import { SdkProtocolError, SdkResultError } from "./errors";
import { lenientOptional, withFallback } from "./lenient-schema";

// The API reports null or omits counts it has no value for, so both mean "unchanged".
const tokenCountSchema = Schema.optional(
  Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
);
const usageSchema = Schema.Struct({
  input_tokens: tokenCountSchema,
  output_tokens: tokenCountSchema,
  cache_read_input_tokens: tokenCountSchema,
  cache_creation_input_tokens: tokenCountSchema,
});
// A missing or malformed model leaves the call unobserved, so the key is omitted.
const modelCallSchema = Schema.Struct({
  model: lenientOptional(Schema.NonEmptyString),
  usage: usageSchema,
});

// Model usage only feeds /claude-sdk-status, so a malformed entry must never fail a turn.
const modelUsageEntrySchema = withFallback(
  Schema.Struct({
    canonicalModel: lenientOptional(Schema.String),
    contextWindow: lenientOptional(Schema.Int.check(Schema.isGreaterThan(0))),
  }),
  {},
);
const modelUsageSchema = withFallback(Schema.Record(Schema.String, modelUsageEntrySchema), {});

// Lenient fields are optional because a fallback only replaces a present value;
// turnResult and the result parser supply the defaults for missing keys.
const resultSchema = Schema.Struct({
  is_error: Schema.Boolean,
  stop_reason: Schema.optional(Schema.NullOr(Schema.String)),
  terminal_reason: Schema.optional(Schema.String),
  errors: Schema.optional(withFallback(Schema.Array(Schema.Unknown), [])),
  result: Schema.optional(withFallback(Schema.String, "")),
  modelUsage: Schema.optional(modelUsageSchema),
});

/** Token counts from one API usage object. Absent counts keep their previous value. */
export type ReportedUsage = typeof usageSchema.Type;

/** Per-model usage reported by a terminal SDK result, keyed by raw request model. */
export type ModelUsage = typeof modelUsageSchema.Type;

/** Outcome of the terminal SDK result. */
export type TurnResult =
  | {
      readonly _tag: "completed";
      readonly stopReason: "stop" | "length";
      readonly terminalReason: string | undefined;
    }
  | { readonly _tag: "failed"; readonly error: Readonly<SdkResultError> };

/** The SDK messages this provider consumes, in its own language. */
export type SdkMessage =
  | { readonly type: "text_delta" | "thinking_delta"; readonly text: string }
  | {
      readonly type: "usage";
      readonly usage: ReportedUsage;
      /** Concrete main-loop model that served this call, when the message names one. */
      readonly model?: string;
      /** Typed API error (such as `authentication_failed`) an assistant message reported. */
      readonly apiError?: string;
    }
  | { readonly type: "result"; readonly result: TurnResult; readonly modelUsage: ModelUsage }
  | { readonly type: "ignored" };

const STOP_REASONS: ReadonlyMap<string, "stop" | "length" | "refusal"> = new Map([
  ["end_turn", "stop"],
  ["pause_turn", "stop"],
  ["stop_sequence", "stop"],
  ["tool_use", "stop"],
  ["tool_deferred", "stop"],
  ["max_tokens", "length"],
  ["model_context_window_exceeded", "length"],
  ["refusal", "refusal"],
]);

const FAILURE_MESSAGES = {
  tool_deferred_unavailable: "could not hand the requested Pi tool call back to Pi",
  refusal: "the model refused to complete the request",
  error: "the query failed without an error description",
} as const;

// Returns undefined for a clean result whose stop reason this provider does not support.
function turnResult(result: typeof resultSchema.Type): TurnResult | undefined {
  const stop = STOP_REASONS.get(result.stop_reason ?? "end_turn");
  const terminalReason =
    result.terminal_reason ??
    (result.stop_reason === "tool_deferred" ? "tool_deferred" : undefined);
  let failure: keyof typeof FAILURE_MESSAGES | undefined;
  if (terminalReason === "tool_deferred_unavailable") {
    failure = terminalReason;
  } else if (result.is_error) {
    failure = "error";
  } else if (stop === "refusal") {
    failure = stop;
  }

  // A failed result wins over its stop reason, so an error never surfaces as a protocol fault.
  if (failure) {
    const reported = (result.errors ?? []).filter((entry) => typeof entry === "string").join("; ");
    const detail = reported || (result.result ?? "") || FAILURE_MESSAGES[failure];
    return { _tag: "failed", error: new SdkResultError({ terminalReason, detail }) };
  }
  if (stop === "stop" || stop === "length") {
    return { _tag: "completed", stopReason: stop, terminalReason };
  }
  return undefined;
}

// Schema leaf messages include the rejected value only when decoding sets reportInput, which
// this module never does, so a detail names the offending path without echoing its value.
const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

function describeIssue(issue: SchemaIssue.Issue): string {
  return formatIssue(issue)
    .issues.map(({ path, message }) =>
      [(path ?? []).map(String).join("."), message].filter(Boolean).join(": "),
    )
    .join("; ");
}

/** Decodes one message kind, failing with a safe protocol detail. */
type MessageParser = (input: unknown) => Result.Result<SdkMessage, string>;

function messageParser<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  toMessage: (value: S["Type"]) => Result.Result<SdkMessage, string>,
): MessageParser {
  const decode = Schema.decodeUnknownResult(schema);
  return (input) =>
    Result.flatMap(
      Result.mapError(decode(input), (error) => describeIssue(error.issue)),
      toMessage,
    );
}

function usageMessage(
  { model, usage }: typeof modelCallSchema.Type,
  apiError: string | undefined,
): Result.Result<SdkMessage, string> {
  return Result.succeed({
    type: "usage",
    usage,
    ...(model === undefined ? {} : { model }),
    ...(apiError === undefined ? {} : { apiError }),
  });
}

// Every SDK message this provider consumes, keyed by its dotted discriminator path.
// Any other kind is ignored, so new SDK message, event, and delta types stay harmless.
const MESSAGE_PARSERS: ReadonlyMap<string, MessageParser> = new Map<string, MessageParser>([
  [
    "stream_event.content_block_delta.text_delta",
    messageParser(
      Schema.Struct({
        event: Schema.Struct({ delta: Schema.Struct({ text: Schema.String }) }),
      }),
      ({ event }) => Result.succeed({ type: "text_delta", text: event.delta.text }),
    ),
  ],
  [
    "stream_event.content_block_delta.thinking_delta",
    messageParser(
      Schema.Struct({
        event: Schema.Struct({ delta: Schema.Struct({ thinking: Schema.String }) }),
      }),
      ({ event }) => Result.succeed({ type: "thinking_delta", text: event.delta.thinking }),
    ),
  ],
  [
    "stream_event.message_start",
    messageParser(
      Schema.Struct({ event: Schema.Struct({ message: modelCallSchema }) }),
      ({ event }) => usageMessage(event.message, undefined),
    ),
  ],
  [
    "stream_event.message_delta",
    messageParser(Schema.Struct({ event: Schema.Struct({ usage: usageSchema }) }), ({ event }) =>
      Result.succeed({ type: "usage", usage: event.usage }),
    ),
  ],
  [
    "assistant",
    messageParser(
      Schema.Struct({ message: modelCallSchema, error: lenientOptional(Schema.String) }),
      ({ message, error }) => usageMessage(message, error),
    ),
  ],
  [
    "result",
    messageParser(resultSchema, (result) => {
      const turn = turnResult(result);
      return turn === undefined
        ? Result.fail(`unsupported stop_reason ${result.stop_reason}`)
        : Result.succeed({ type: "result", result: turn, modelUsage: result.modelUsage ?? {} });
    }),
  ],
]);

// Only the discriminators are read, so other keys may be stripped.
const decodeNode = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.String,
    event: Schema.optional(Schema.Unknown),
    delta: Schema.optional(Schema.Unknown),
  }),
);

// The message type, then its stream event type, then its content delta type.
function kindOf(input: unknown): string | undefined {
  const message = Option.getOrUndefined(decodeNode(input));
  if (message?.type !== "stream_event") {
    return message?.type;
  }
  const event = Option.getOrUndefined(decodeNode(message.event));
  if (event?.type !== "content_block_delta") {
    return `stream_event.${event?.type}`;
  }
  return `stream_event.content_block_delta.${Option.getOrUndefined(decodeNode(event.delta))?.type}`;
}

/**
 * Parse one untrusted SDK stream message.
 *
 * @param input - Value yielded by the SDK query.
 * @returns The consumed message, `ignored` for kinds this provider does not use, or a protocol error.
 */
export function parseSdkMessage(input: unknown): Result.Result<SdkMessage, SdkProtocolError> {
  const kind = kindOf(input);
  if (kind === undefined) {
    return Result.fail(
      new SdkProtocolError({ messageType: "message", detail: "type must be a string" }),
    );
  }
  const parse = MESSAGE_PARSERS.get(kind);
  if (parse === undefined) {
    return Result.succeed({ type: "ignored" });
  }
  return Result.mapError(
    parse(input),
    (detail) => new SdkProtocolError({ messageType: kind, detail }),
  );
}

/**
 * Fold one usage report into the turn's running token counts.
 *
 * @param previous - Counts accumulated so far this turn.
 * @param reported - Counts from the newest usage report.
 * @returns Complete counts where each reported value replaces the previous one.
 */
export function applyUsage(previous: TokenUsage | undefined, reported: ReportedUsage): TokenUsage {
  return {
    input: reported.input_tokens ?? previous?.input ?? 0,
    output: reported.output_tokens ?? previous?.output ?? 0,
    cacheRead: reported.cache_read_input_tokens ?? previous?.cacheRead ?? 0,
    cacheWrite: reported.cache_creation_input_tokens ?? previous?.cacheWrite ?? 0,
  };
}

/**
 * Read the context window the SDK reported for a concrete model id.
 *
 * Entries are keyed by the model string each request named, while
 * `message_start` reports the served model, so either side may carry a date
 * suffix the other lacks (a pinned `claude-haiku-4-5` request is served as
 * `claude-haiku-4-5-20251001`). An entry matches when its key or its
 * `canonicalModel` equals the observed main-loop model once both are undated.
 *
 * @param modelUsage - Per-model usage from the terminal SDK result.
 * @param model - Concrete main-loop model id observed for the turn.
 * @returns Context window in tokens, or undefined when unreported.
 */
export function contextWindowFor(modelUsage: ModelUsage, model: string): number | undefined {
  const wanted = undatedModelId(model);
  return Object.entries(modelUsage).find(
    ([key, entry]) =>
      (undatedModelId(key) === wanted ||
        (entry.canonicalModel !== undefined && undatedModelId(entry.canonicalModel) === wanted)) &&
      entry.contextWindow !== undefined,
  )?.[1].contextWindow;
}
