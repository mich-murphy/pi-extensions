import { z } from "zod";
import type { TokenUsage } from "../bridge";
import { SdkProtocolError, SdkResultError } from "./errors";

// The API reports null or omits counts it has no value for, so both mean "unchanged".
const tokenCountSchema = z.number().nonnegative().nullish();
const usageSchema = z.object({
  input_tokens: tokenCountSchema,
  output_tokens: tokenCountSchema,
  cache_read_input_tokens: tokenCountSchema,
  cache_creation_input_tokens: tokenCountSchema,
});
const modelCallSchema = z.object({
  model: z.string().min(1).optional().catch(undefined),
  usage: usageSchema,
});

// Model usage only feeds /claude-sdk-status, so a malformed entry must never fail a turn.
const modelUsageSchema = z
  .record(
    z.string(),
    z
      .object({
        canonicalModel: z.string().optional().catch(undefined),
        contextWindow: z.number().int().positive().optional().catch(undefined),
      })
      .catch({}),
  )
  .catch({});

const resultSchema = z.object({
  is_error: z.boolean(),
  stop_reason: z.string().nullish(),
  terminal_reason: z.string().optional(),
  errors: z.array(z.unknown()).catch([]),
  result: z.string().catch(""),
  modelUsage: modelUsageSchema,
});

/** Token counts from one API usage object. Absent counts keep their previous value. */
export type ReportedUsage = z.output<typeof usageSchema>;

/** Per-model usage reported by a terminal SDK result, keyed by raw request model. */
export type ModelUsage = z.output<typeof modelUsageSchema>;

/** Outcome of the terminal SDK result. */
export type TurnResult =
  | {
      readonly _tag: "completed";
      readonly stopReason: "stop" | "length";
      readonly terminalReason: string | undefined;
    }
  | { readonly _tag: "failed"; readonly error: SdkResultError };

/** The SDK messages this provider consumes, in its own language. */
export type SdkMessage =
  | { readonly type: "text_delta" | "thinking_delta"; readonly text: string }
  | {
      readonly type: "usage";
      readonly usage: ReportedUsage;
      /** Concrete main-loop model that served this call, when the message names one. */
      readonly model?: string | undefined;
    }
  | { readonly type: "result"; readonly result: TurnResult; readonly modelUsage: ModelUsage }
  | { readonly type: "ignored" };

/** Result of parsing an untrusted SDK protocol value. */
export type ParseResult<T> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "err"; readonly error: SdkProtocolError };

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
  tool_deferred_unavailable:
    "Claude Agent SDK could not honor the deferred Pi tool call (terminal_reason: tool_deferred_unavailable)",
  refusal: "The model refused to complete the request",
  error: "Claude Agent SDK reported an error result",
} as const;

function turnResult(result: z.output<typeof resultSchema>, ctx: z.RefinementCtx): TurnResult {
  const stop = STOP_REASONS.get(result.stop_reason ?? "end_turn");
  const terminalReason =
    result.terminal_reason ??
    (result.stop_reason === "tool_deferred" ? "tool_deferred" : undefined);
  let failure: keyof typeof FAILURE_MESSAGES | undefined;
  if (terminalReason === "tool_deferred_unavailable") failure = terminalReason;
  else if (result.is_error) failure = "error";
  else if (stop === "refusal") failure = stop;

  // A failed result wins over its stop reason, so an error never surfaces as a protocol fault.
  if (failure) {
    const reported = result.errors.filter((entry) => typeof entry === "string").join("; ");
    const detail = reported || result.result || FAILURE_MESSAGES[failure];
    return { _tag: "failed", error: new SdkResultError(terminalReason, detail) };
  }
  if (stop === "stop" || stop === "length") {
    return { _tag: "completed", stopReason: stop, terminalReason };
  }
  ctx.issues.push({
    code: "custom",
    message: `unsupported stop_reason ${result.stop_reason}`,
    input: result.stop_reason,
  });
  return z.NEVER;
}

// Every SDK message this provider consumes, keyed by its dotted discriminator path.
// Any other kind is ignored, so new SDK message, event, and delta types stay harmless.
const MESSAGE_SCHEMAS: ReadonlyMap<string, z.ZodType<SdkMessage>> = new Map<
  string,
  z.ZodType<SdkMessage>
>([
  [
    "stream_event.content_block_delta.text_delta",
    z
      .object({ event: z.object({ delta: z.object({ text: z.string() }) }) })
      .transform(({ event }): SdkMessage => ({ type: "text_delta", text: event.delta.text })),
  ],
  [
    "stream_event.content_block_delta.thinking_delta",
    z
      .object({ event: z.object({ delta: z.object({ thinking: z.string() }) }) })
      .transform(
        ({ event }): SdkMessage => ({ type: "thinking_delta", text: event.delta.thinking }),
      ),
  ],
  [
    "stream_event.message_start",
    z
      .object({ event: z.object({ message: modelCallSchema }) })
      .transform(({ event }): SdkMessage => ({ type: "usage", ...event.message })),
  ],
  [
    "stream_event.message_delta",
    z
      .object({ event: z.object({ usage: usageSchema }) })
      .transform(({ event }): SdkMessage => ({ type: "usage", ...event })),
  ],
  [
    "assistant",
    z
      .object({ message: modelCallSchema })
      .transform(({ message }): SdkMessage => ({ type: "usage", ...message })),
  ],
  [
    "result",
    resultSchema.transform(
      (result, ctx): SdkMessage => ({
        type: "result",
        result: turnResult(result, ctx),
        modelUsage: result.modelUsage,
      }),
    ),
  ],
]);

const nodeSchema = z.looseObject({
  type: z.string(),
  event: z.unknown().optional(),
  delta: z.unknown().optional(),
});

// The message type, then its stream event type, then its content delta type.
function kindOf(input: unknown): string | undefined {
  const message = nodeSchema.safeParse(input).data;
  if (message?.type !== "stream_event") return message?.type;
  const event = nodeSchema.safeParse(message.event).data;
  if (event?.type !== "content_block_delta") return `stream_event.${event?.type}`;
  return `stream_event.content_block_delta.${nodeSchema.safeParse(event.delta).data?.type}`;
}

function issueSummary(error: z.ZodError): string {
  return error.issues
    .map((issue) => [issue.path.join("."), issue.message].filter(Boolean).join(": "))
    .join("; ");
}

/**
 * Parse one untrusted SDK stream message.
 *
 * @param input - Value yielded by the SDK query.
 * @returns The consumed message, `ignored` for kinds this provider does not use, or a protocol error.
 */
export function parseSdkMessage(input: unknown): ParseResult<SdkMessage> {
  const kind = kindOf(input);
  if (kind === undefined) {
    return { _tag: "err", error: new SdkProtocolError("message", "type must be a string") };
  }
  const parsed = MESSAGE_SCHEMAS.get(kind)?.safeParse(input);
  if (!parsed) return { _tag: "ok", value: { type: "ignored" } };
  if (parsed.success) return { _tag: "ok", value: parsed.data };
  return { _tag: "err", error: new SdkProtocolError(kind, issueSummary(parsed.error)) };
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
 * Entries are keyed by the raw model string of each request, which may carry a
 * date suffix, so an entry matches when its key or its `canonicalModel` equals
 * the observed main-loop model.
 *
 * @param modelUsage - Per-model usage from the terminal SDK result.
 * @param model - Concrete main-loop model id observed for the turn.
 * @returns Context window in tokens, or undefined when unreported.
 */
export function contextWindowFor(modelUsage: ModelUsage, model: string): number | undefined {
  return Object.entries(modelUsage).find(
    ([key, entry]) =>
      (key === model || entry.canonicalModel === model) && entry.contextWindow !== undefined,
  )?.[1].contextWindow;
}
