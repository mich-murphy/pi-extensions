import { Option, Result, Schema, SchemaIssue } from "effect";
import type { TokenUsage } from "../bridge";
import { undatedModelId } from "../models";
import { SdkProtocolError, SdkResultError } from "./errors";
import { lenientOptional, withFallback } from "./lenient-schema";
import { resultFailureCategory, safeApiError, safeTerminalReason } from "./result-failure";

const tokenCountSchema = Schema.optional(
  Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
);
const usageSchema = Schema.Struct({
  input_tokens: tokenCountSchema,
  output_tokens: tokenCountSchema,
  cache_read_input_tokens: tokenCountSchema,
  cache_creation_input_tokens: tokenCountSchema,
  cache_creation: lenientOptional(
    Schema.Struct({
      ephemeral_5m_input_tokens: tokenCountSchema,
      ephemeral_1h_input_tokens: tokenCountSchema,
    }),
  ),
});
const modelCallSchema = Schema.Struct({
  model: lenientOptional(Schema.NonEmptyString),
  usage: usageSchema,
});

const diagnosticTokenCount = lenientOptional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)));
const modelUsageEntrySchema = withFallback(
  Schema.Struct({
    inputTokens: diagnosticTokenCount,
    cacheReadInputTokens: diagnosticTokenCount,
    cacheCreationInputTokens: diagnosticTokenCount,
    canonicalModel: lenientOptional(Schema.String),
    contextWindow: lenientOptional(Schema.Int.check(Schema.isGreaterThan(0))),
    maxOutputTokens: lenientOptional(Schema.Int.check(Schema.isGreaterThan(0))),
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
  subtype: lenientOptional(Schema.String),
  usage: Schema.optional(usageSchema),
  modelUsage: Schema.optional(modelUsageSchema),
  num_turns: lenientOptional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
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
      /** Complete assistant tool_use blocks, not partial streaming blocks. */
      readonly assistantToolUses?: number;
      /** Main-loop message_start only; identifiers stay local and are never diagnostics. */
      readonly modelRequestStart?: { readonly id?: string };
    }
  | { readonly type: "tool_results"; readonly errorToolResults: number }
  | {
      readonly type: "usage_limit";
      /** When the rejected subscription window reopens, in epoch milliseconds. */
      readonly resetsAt: number | undefined;
    }
  | {
      readonly type: "result";
      readonly result: TurnResult;
      /** Authoritative cumulative main-loop totals across model round-trips in this turn. */
      readonly usage?: ReportedUsage;
      readonly modelUsage: ModelUsage;
      /** Model round-trips within this turn; not the number of Pi turns. */
      readonly numTurns?: number;
    }
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

function turnResult(result: typeof resultSchema.Type): TurnResult | undefined {
  const stop = STOP_REASONS.get(result.stop_reason ?? "end_turn");
  const terminalReason =
    safeTerminalReason(result.terminal_reason) ??
    (result.stop_reason === "tool_deferred" ? "tool_deferred" : undefined);
  let failure: "tool-contract" | "provider" | "refusal" | undefined;
  if (terminalReason === "tool_deferred_unavailable") {
    failure = "tool-contract";
  } else if (result.is_error) {
    failure = "provider";
  } else if (stop === "refusal") {
    failure = stop;
  }

  if (failure) {
    const category =
      failure === "provider" ? resultFailureCategory(terminalReason, result.subtype) : failure;
    return { _tag: "failed", error: new SdkResultError({ terminalReason, category }) };
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
  const safeError = safeApiError(apiError);
  return Result.succeed({
    type: "usage",
    usage,
    ...(model === undefined ? {} : { model }),
    ...(safeError === undefined ? {} : { apiError: safeError }),
  });
}

/** Inspect only discriminants, never content, arguments, ids, or tool output payloads. */
function countBlocks(blocks: readonly unknown[], type: string, errorsOnly = false): number {
  return blocks.filter(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === type &&
      (!errorsOnly || ("is_error" in block && block.is_error === true)),
  ).length;
}

// Every rate-limit update replaces recovery metadata, including malformed/unknown updates.
// Never retain an earlier rejected window after the SDK changes its rate-limit information.
const decodeRateLimit = Schema.decodeUnknownOption(
  Schema.Struct({
    rate_limit_info: Schema.Struct({
      status: Schema.String,
      // Bound seconds to JavaScript's Date range before converting to milliseconds.
      resetsAt: lenientOptional(
        Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(8_640_000_000_000)),
      ),
    }),
  }),
);

function rateLimitMessage(input: unknown): Result.Result<SdkMessage, string> {
  const info = Option.getOrUndefined(decodeRateLimit(input))?.rate_limit_info;
  // Claude Code reports resetsAt in epoch seconds.
  return Result.succeed({
    type: "usage_limit",
    resetsAt:
      info?.status === "rejected" && info.resetsAt !== undefined ? info.resetsAt * 1000 : undefined,
  });
}

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
      Schema.Struct({
        event: Schema.Struct({
          message: Schema.Struct({ ...modelCallSchema.fields, id: lenientOptional(Schema.String) }),
        }),
      }),
      ({ event }) =>
        Result.map(usageMessage(event.message, undefined), (message) => ({
          ...message,
          modelRequestStart: event.message.id === undefined ? {} : { id: event.message.id },
        })),
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
      Schema.Struct({
        message: Schema.Struct({
          ...modelCallSchema.fields,
          content: lenientOptional(Schema.Array(Schema.Unknown)),
        }),
        error: lenientOptional(Schema.String),
      }),
      ({ message, error }) =>
        Result.map(usageMessage(message, error), (parsed) => ({
          ...parsed,
          ...(message.content === undefined
            ? {}
            : { assistantToolUses: countBlocks(message.content, "tool_use") }),
        })),
    ),
  ],
  [
    "user",
    messageParser(
      Schema.Struct({
        message: lenientOptional(
          Schema.Struct({ content: lenientOptional(Schema.Array(Schema.Unknown)) }),
        ),
      }),
      ({ message }) => {
        const errorToolResults = countBlocks(message?.content ?? [], "tool_result", true);
        return Result.succeed(
          errorToolResults === 0 ? { type: "ignored" } : { type: "tool_results", errorToolResults },
        );
      },
    ),
  ],
  ["rate_limit_event", rateLimitMessage],
  [
    "result",
    messageParser(resultSchema, (result) => {
      const turn = turnResult(result);
      return turn === undefined
        ? Result.fail("unsupported stop_reason")
        : Result.succeed({
            type: "result",
            result: turn,
            ...(result.usage === undefined ? {} : { usage: result.usage }),
            modelUsage: result.modelUsage ?? {},
            ...(result.num_turns === undefined ? {} : { numTurns: result.num_turns }),
          });
    }),
  ],
]);

const decodeNode = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.String,
    event: Schema.optional(Schema.Unknown),
    delta: Schema.optional(Schema.Unknown),
  }),
);

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
 * @param scope - Terminal turn totals must not inherit a per-call cache-write split.
 * @returns Complete counts where each reported value replaces the previous one.
 */
export function applyUsage(
  previous: TokenUsage | undefined,
  reported: ReportedUsage,
  scope: "call" | "turn" = "call",
): TokenUsage {
  const prior = previous ?? NO_USAGE;
  return {
    input: reported.input_tokens ?? prior.input,
    output: reported.output_tokens ?? prior.output,
    cacheRead: reported.cache_read_input_tokens ?? prior.cacheRead,
    cacheWrite: reported.cache_creation_input_tokens ?? prior.cacheWrite,
    ...cacheWriteSplit(reported.cache_creation ?? {}, scope === "turn" ? NO_USAGE : prior),
  };
}

const NO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** The 1-hour/5-minute split of cache writes, keeping earlier values the report omits. */
function cacheWriteSplit(
  creation: NonNullable<ReportedUsage["cache_creation"]>,
  prior: TokenUsage,
): Pick<TokenUsage, "cacheWrite1h" | "cacheWrite5m"> {
  const cacheWrite1h = creation.ephemeral_1h_input_tokens ?? prior.cacheWrite1h;
  const cacheWrite5m = creation.ephemeral_5m_input_tokens ?? prior.cacheWrite5m;
  return {
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
    ...(cacheWrite5m === undefined ? {} : { cacheWrite5m }),
  };
}

/**
 * Entries are keyed by the model string each request named, while
 * `message_start` reports the served model, so either side may carry a date
 * suffix the other lacks (a pinned `claude-haiku-4-5` request is served as
 * `claude-haiku-4-5-20251001`). An entry matches when its key or its
 * `canonicalModel` equals the observed main-loop model once both are undated.
 */
function modelLimitFor(
  modelUsage: ModelUsage,
  model: string,
  field: "contextWindow" | "maxOutputTokens",
): number | undefined {
  const wanted = undatedModelId(model);
  return Object.entries(modelUsage).find(
    ([key, entry]) =>
      (undatedModelId(key) === wanted ||
        (entry.canonicalModel !== undefined && undatedModelId(entry.canonicalModel) === wanted)) &&
      entry[field] !== undefined,
  )?.[1][field];
}

/**
 * Read the context window the SDK reported for a concrete model id.
 *
 * @param modelUsage - Per-model usage from the terminal SDK result.
 * @param model - Concrete main-loop model id observed for the turn.
 * @returns Context window in tokens, or undefined when unreported.
 */
export function contextWindowFor(modelUsage: ModelUsage, model: string): number | undefined {
  return modelLimitFor(modelUsage, model, "contextWindow");
}

/**
 * Read the output limit the SDK reported for a concrete model id.
 *
 * @param modelUsage - Per-model usage from the terminal SDK result.
 * @param model - Concrete main-loop model id observed for the turn.
 * @returns Maximum output tokens, or undefined when unreported.
 */
export function maxOutputTokensFor(modelUsage: ModelUsage, model: string): number | undefined {
  return modelLimitFor(modelUsage, model, "maxOutputTokens");
}
