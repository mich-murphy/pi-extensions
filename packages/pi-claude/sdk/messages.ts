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

const resultSchema = Schema.Struct({
  is_error: Schema.Boolean,
  stop_reason: Schema.optional(Schema.NullOr(Schema.String)),
  terminal_reason: Schema.optional(Schema.String),
  subtype: lenientOptional(Schema.String),
  usage: Schema.optional(usageSchema),
  modelUsage: Schema.optional(modelUsageSchema),
  num_turns: lenientOptional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

export type ReportedUsage = typeof usageSchema.Type;

export type ModelUsage = typeof modelUsageSchema.Type;

export type TurnResult =
  | {
      readonly _tag: "completed";
      readonly stopReason: "stop" | "length";
      readonly terminalReason: string | undefined;
    }
  | { readonly _tag: "failed"; readonly error: SdkResultError };

export type SdkMessage =
  | { readonly type: "text_delta" | "thinking_delta"; readonly text: string }
  | {
      readonly type: "usage";
      readonly usage: ReportedUsage;
      readonly model?: string;
      readonly apiError?: string;
      readonly assistantToolUses?: number;
      readonly modelRequestStart?: { readonly id?: string };
      readonly requestStopped?: true;
    }
  | { readonly type: "api_retry" }
  | { readonly type: "tool_results"; readonly errorToolResults: number }
  | {
      readonly type: "usage_limit";
      readonly resetsAt: number | undefined;
      readonly rejected: boolean;
      readonly overage?: { readonly resetsAt: number | undefined };
    }
  | {
      readonly type: "result";
      readonly result: TurnResult;
      readonly usage?: ReportedUsage;
      readonly modelUsage: ModelUsage;
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

    return {
      _tag: "failed",
      error: new SdkResultError({ terminalReason, category }),
    };
  }

  if (stop === "stop" || stop === "length") {
    return { _tag: "completed", stopReason: stop, terminalReason };
  }

  return undefined;
}

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

function describeIssue(issue: SchemaIssue.Issue): string {
  return formatIssue(issue)
    .issues.map(({ path, message }) =>
      [(path ?? []).map(String).join("."), message].filter(Boolean).join(": "),
    )
    .join("; ");
}

type MessageParser = (input: SdkEventEnvelope) => Result.Result<SdkMessage, string>;

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

type ObservedUsage = Extract<SdkMessage, { type: "usage" }>;

type UsageMessage = { -readonly [Key in keyof ObservedUsage]: ObservedUsage[Key] };

function usageMessage(
  { model, usage }: typeof modelCallSchema.Type,
  apiError: string | undefined,
): UsageMessage {
  const safeError = safeApiError(apiError);
  const message: UsageMessage = { type: "usage", usage };

  if (model !== undefined) {
    message.model = model;
  }

  if (safeError !== undefined) {
    message.apiError = safeError;
  }

  return message;
}

const blockSchema = withFallback(
  Schema.UndefinedOr(
    Schema.Struct({ type: Schema.String, is_error: lenientOptional(Schema.Boolean) }),
  ),
  undefined,
);

type WireBlock = typeof blockSchema.Type;

function countBlocks(blocks: ReadonlyArray<WireBlock>, type: string, errorsOnly = false): number {
  return blocks.filter((block) => block?.type === type && (!errorsOnly || block.is_error === true))
    .length;
}

const MILLISECONDS_PER_SECOND = 1000;
const MAX_DATE_EPOCH_SECONDS = 8_640_000_000_000;

const EpochSeconds = Schema.Finite.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(MAX_DATE_EPOCH_SECONDS),
);

const decodeRateLimit = Schema.decodeUnknownOption(
  Schema.Struct({
    rate_limit_info: Schema.Struct({
      status: Schema.String,
      resetsAt: lenientOptional(EpochSeconds),
      rateLimitType: lenientOptional(Schema.String),
      isUsingOverage: lenientOptional(Schema.Boolean),
      overageResetsAt: lenientOptional(EpochSeconds),
    }),
  }),
);

function rateLimitMessage(input: SdkEventEnvelope): Result.Result<SdkMessage, string> {
  const info = Option.getOrUndefined(decodeRateLimit(input))?.rate_limit_info;
  const overageReset = info?.overageResetsAt ?? info?.resetsAt;

  const overage =
    info?.isUsingOverage === true ||
    (info?.rateLimitType === "overage" && info.status !== "rejected")
      ? {
          overage: {
            resetsAt:
              overageReset === undefined ? undefined : overageReset * MILLISECONDS_PER_SECOND,
          },
        }
      : {};

  return Result.succeed({
    type: "usage_limit",
    rejected: info?.status === "rejected",
    resetsAt:
      info?.status === "rejected" && info.resetsAt !== undefined
        ? info.resetsAt * MILLISECONDS_PER_SECOND
        : undefined,
    ...overage,
  });
}

type ResultUsage = { usage?: ReportedUsage };

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
      ({ event }) => {
        const message = usageMessage(event.message, undefined);
        message.modelRequestStart = event.message.id === undefined ? {} : { id: event.message.id };

        return Result.succeed(message);
      },
    ),
  ],
  [
    "stream_event.message_delta",
    messageParser(
      Schema.Struct({
        event: Schema.Struct({
          usage: usageSchema,
          delta: lenientOptional(
            Schema.Struct({ stop_reason: lenientOptional(Schema.NullOr(Schema.String)) }),
          ),
        }),
      }),
      ({ event }) => {
        const message: UsageMessage = { type: "usage", usage: event.usage };
        const stopReason = event.delta?.stop_reason;

        if (stopReason !== undefined && stopReason !== null && stopReason !== "") {
          message.requestStopped = true;
        }

        return Result.succeed(message);
      },
    ),
  ],
  [
    "assistant",
    messageParser(
      Schema.Struct({
        message: Schema.Struct({
          ...modelCallSchema.fields,
          content: lenientOptional(Schema.Array(blockSchema)),
        }),
        error: lenientOptional(Schema.String),
      }),
      ({ message, error }) => {
        const parsed = usageMessage(message, error);

        if (message.content !== undefined) {
          parsed.assistantToolUses = countBlocks(message.content, "tool_use");
        }

        return Result.succeed(parsed);
      },
    ),
  ],
  [
    "user",
    messageParser(
      Schema.Struct({
        message: lenientOptional(
          Schema.Struct({ content: lenientOptional(Schema.Array(blockSchema)) }),
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
  ["system.api_retry", () => Result.succeed({ type: "api_retry" })],
  [
    "result",
    messageParser(resultSchema, (result) => {
      const turn = turnResult(result);

      if (turn === undefined) {
        return Result.fail("unsupported stop_reason");
      }

      const reported: ResultUsage = {};

      if (result.usage !== undefined) {
        reported.usage = result.usage;
      }

      const message: Omit<Extract<SdkMessage, { type: "result" }>, "numTurns"> & {
        numTurns?: number;
      } = {
        type: "result",
        result: turn,
        ...reported,
        modelUsage: result.modelUsage ?? {},
      };

      if (result.num_turns !== undefined) {
        message.numTurns = result.num_turns;
      }

      return Result.succeed(message);
    }),
  ],
]);

const nodeSchema = Schema.Struct({
  type: Schema.String,
  subtype: lenientOptional(Schema.String),
  event: Schema.optional(Schema.Unknown),
  delta: Schema.optional(Schema.Unknown),
  claude_code_version: Schema.optional(Schema.Unknown),
  message: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
  is_error: Schema.optional(Schema.Unknown),
  stop_reason: Schema.optional(Schema.Unknown),
  terminal_reason: Schema.optional(Schema.Unknown),
  usage: Schema.optional(Schema.Unknown),
  modelUsage: Schema.optional(Schema.Unknown),
  num_turns: Schema.optional(Schema.Unknown),
  rate_limit_info: Schema.optional(Schema.Unknown),
});

const decodeNode = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.String,
    delta: Schema.optional(Schema.Unknown),
  }),
);

export const decodeSdkEvent = Schema.decodeUnknownOption(nodeSchema);

type SdkEventEnvelope = typeof nodeSchema.Type;

function kindOf(message: SdkEventEnvelope): string {
  if (message.type === "system") {
    return message.subtype === undefined ? "system" : `system.${message.subtype}`;
  }

  if (message.type !== "stream_event") {
    return message.type;
  }

  const event = Option.getOrUndefined(decodeNode(message.event));

  if (event?.type !== "content_block_delta") {
    return `stream_event.${event?.type}`;
  }

  return `stream_event.content_block_delta.${Option.getOrUndefined(decodeNode(event.delta))?.type}`;
}

export function parseSdkMessage(
  decoded: ReturnType<typeof decodeSdkEvent>,
): Result.Result<SdkMessage, SdkProtocolError> {
  if (Option.isNone(decoded)) {
    return Result.fail(
      new SdkProtocolError({ messageType: "message", detail: "type must be a string" }),
    );
  }

  const kind = kindOf(decoded.value);
  const parse = MESSAGE_PARSERS.get(kind);

  if (parse === undefined) {
    return Result.succeed({ type: "ignored" });
  }

  return Result.mapError(
    parse(decoded.value),
    (detail) => new SdkProtocolError({ messageType: kind, detail }),
  );
}

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

type CacheWriteSplit = { cacheWrite1h?: number; cacheWrite5m?: number };

function cacheWriteSplit(
  creation: NonNullable<ReportedUsage["cache_creation"]>,
  prior: TokenUsage,
): CacheWriteSplit {
  const cacheWrite1h = creation.ephemeral_1h_input_tokens ?? prior.cacheWrite1h;
  const cacheWrite5m = creation.ephemeral_5m_input_tokens ?? prior.cacheWrite5m;
  const split: CacheWriteSplit = {};

  if (cacheWrite1h !== undefined) {
    split.cacheWrite1h = cacheWrite1h;
  }

  if (cacheWrite5m !== undefined) {
    split.cacheWrite5m = cacheWrite5m;
  }

  return split;
}

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

export function contextWindowFor(modelUsage: ModelUsage, model: string): number | undefined {
  return modelLimitFor(modelUsage, model, "contextWindow");
}

export function maxOutputTokensFor(modelUsage: ModelUsage, model: string): number | undefined {
  return modelLimitFor(modelUsage, model, "maxOutputTokens");
}
