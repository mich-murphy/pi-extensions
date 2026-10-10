import { once } from "node:events";
import process from "node:process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Context, Duration, Effect, Layer, Result, Schema } from "effect";
import { subscriptionEnvironment } from "./sdk/subscription-environment";

// The pattern behind zod's z.iso.datetime({ offset: true }): an RFC 3339 calendar date (leap
// years included), a time with required seconds and optional fraction, then Z or +hh:mm.
const CALENDAR_DATE = String.raw`(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|02-(?:0[1-9]|1\d|2[0-8])))`;
const OFFSET_DATE_TIME = new RegExp(
  String.raw`^${CALENDAR_DATE}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$`,
  "u",
);

const usageWindowFields = {
  utilization: Schema.NullOr(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  resets_at: Schema.NullOr(Schema.String.check(Schema.isPattern(OFFSET_DATE_TIME))),
};

const usageWindowSchema = Schema.Struct(usageWindowFields);
const modelScopedWindowSchema = Schema.Struct({
  ...usageWindowFields,
  display_name: Schema.NonEmptyString,
});

const rateLimitsSchema = Schema.Struct({
  five_hour: Schema.optional(Schema.NullOr(usageWindowSchema)),
  seven_day: Schema.optional(Schema.NullOr(usageWindowSchema)),
  model_scoped: Schema.optional(Schema.Array(modelScopedWindowSchema)),
  extra_usage: Schema.optional(Schema.NullOr(Schema.Struct({ is_enabled: Schema.Boolean }))),
});

const decodeUsageResponse = Schema.decodeUnknownResult(
  Schema.Struct({
    subscription_type: Schema.NullOr(Schema.String),
    rate_limits_available: Schema.Boolean,
    rate_limits: Schema.NullOr(rateLimitsSchema),
  }),
);

/** One Claude subscription rate-limit window. */
export type ClaudeUsageWindow = {
  /** Human-readable window name supplied by this adapter or by Claude. */
  readonly name: string;
  /** Percentage of the allowance consumed, when Claude reports it. */
  readonly usedPercent: number | null;
  /** ISO timestamp at which the allowance resets, when Claude reports it. */
  readonly resetsAt: string | null;
};

/** Parsed Claude subscription usage suitable for display. */
export type ClaudeUsageStatus = {
  /** Claude subscription type, or null outside subscription authentication. */
  readonly subscriptionType: string | null;
  /** Whether Claude returned plan rate limits for this account. */
  readonly rateLimitsAvailable: boolean;
  /** General and model-specific plan windows. */
  readonly windows: readonly ClaudeUsageWindow[];
  /** Whether paid extra usage is enabled. */
  readonly extraUsageEnabled: boolean | null;
};

const UsageInspectionOperation = Schema.Literals(["start", "read", "parse", "close"]);

const USAGE_FAILURE_MESSAGES: Readonly<Record<typeof UsageInspectionOperation.Type, string>> = {
  start: "Could not start a Claude session to read usage",
  read: "Claude did not return usage data",
  parse: "Claude returned usage data in an unexpected format",
  close: "Could not close the Claude usage session",
};

/** Expected failure while starting, reading, parsing, or closing a Claude usage session. */
class ClaudeUsageInspectionError extends Schema.TaggedError<ClaudeUsageInspectionError>()(
  "ClaudeUsageInspectionError",
  {
    /** Inspection step that failed. */
    operation: UsageInspectionOperation,
    /** Unclassified local cause. Callers must not render it. */
    cause: Schema.optional(Schema.Defect()),
  },
) {
  /** Plain-English summary of the failed step. */
  override get message(): string {
    return USAGE_FAILURE_MESSAGES[this.operation];
  }
}

/** Expected failure when Claude does not answer the usage request in time. */
class ClaudeUsageTimeoutError extends Schema.TaggedError<ClaudeUsageTimeoutError>()(
  "ClaudeUsageTimeoutError",
  {
    /** How long the inspection waited. */
    timeout: Schema.Duration,
  },
) {
  /** Plain-English summary naming the wait. */
  override get message(): string {
    return `Timed out after ${Duration.format(this.timeout)} waiting for Claude usage`;
  }
}

/** Minimal live SDK query used by usage inspection. */
export type ClaudeUsageQuery = {
  /** Request the SDK's experimental structured `/usage` response. */
  readonly readUsage: () => Promise<unknown>;
  /** Close the idle SDK session and its subprocess. */
  readonly close: () => Promise<void>;
};

/** Starts an idle, subscription-authenticated SDK query that ends when the controller aborts. */
export type StartClaudeUsageQuery = (abortController: AbortController) => ClaudeUsageQuery;

// oxlint-disable-next-line eslint/require-yield -- The idle prompt sends no message; it only holds SDK input open until abort.
async function* idlePrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  if (signal.aborted) {
    return;
  }
  await once(signal, "abort");
}

function defaultStartClaudeUsageQuery(abortController: AbortController): ClaudeUsageQuery {
  const sdkQuery = query({
    prompt: idlePrompt(abortController.signal),
    options: {
      abortController,
      cwd: process.cwd(),
      env: { ...subscriptionEnvironment() },
      persistSession: false,
      settingSources: [],
      tools: [],
    },
  });
  return {
    readUsage: async () => sdkQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
    close: async () => {
      await sdkQuery.return();
    },
  };
}

/** Starts idle, subscription-authenticated SDK sessions used to read Claude usage. */
export class ClaudeUsageQueries extends Context.Service<
  ClaudeUsageQueries,
  {
    /** Start an idle SDK session that ends when the controller aborts. */
    readonly start: (
      abortController: AbortController,
    ) => Effect.Effect<ClaudeUsageQuery, ClaudeUsageInspectionError>;
  }
>()("pi-claude-sdk-provider/sdk-usage/ClaudeUsageQueries") {
  /**
   * Build the service from a raw starter, translating a thrown startup failure into a typed error.
   *
   * @param startQuery - Raw SDK subprocess starter.
   * @returns A layer providing the service.
   */
  static fromStart(startQuery: StartClaudeUsageQuery): Layer.Layer<ClaudeUsageQueries> {
    return Layer.succeed(
      ClaudeUsageQueries,
      ClaudeUsageQueries.of({
        start: Effect.fn("ClaudeUsageQueries.start")(function* (abortController: AbortController) {
          return yield* Effect.try({
            try: () => startQuery(abortController),
            catch: (cause) => new ClaudeUsageInspectionError({ operation: "start", cause }),
          });
        }),
      }),
    );
  }

  /** Live service: an Agent SDK query in the current working directory. */
  static readonly layer: Layer.Layer<ClaudeUsageQueries> = ClaudeUsageQueries.fromStart(
    defaultStartClaudeUsageQuery,
  );
}

function parseUsageResponse(
  input: unknown,
): Result.Result<ClaudeUsageStatus, ClaudeUsageInspectionError> {
  const parsed = decodeUsageResponse(input);
  if (Result.isFailure(parsed)) {
    return Result.fail(
      new ClaudeUsageInspectionError({ operation: "parse", cause: parsed.failure }),
    );
  }

  const limits = parsed.success.rate_limits;
  const windows = [
    { name: "Current session", window: limits?.five_hour },
    { name: "Weekly", window: limits?.seven_day },
    ...(limits?.model_scoped ?? []).map((window) => ({
      name: `${window.display_name} weekly`,
      window,
    })),
  ].flatMap(({ name, window }) =>
    window ? [{ name, usedPercent: window.utilization, resetsAt: window.resets_at }] : [],
  );
  return Result.succeed({
    subscriptionType: parsed.success.subscription_type,
    rateLimitsAvailable: parsed.success.rate_limits_available,
    windows,
    extraUsageEnabled: limits?.extra_usage?.is_enabled ?? null,
  });
}

/**
 * Read current Claude subscription usage without sending a model prompt.
 *
 * The idle session is always aborted and closed, including after a failed read or an
 * interruption. A read, parse, or timeout failure wins over a cleanup failure.
 *
 * @param timeout - Maximum wait for the SDK response, and again for cleanup.
 * @returns Parsed usage, failing with a typed startup, read, parse, timeout, or cleanup error.
 */
export const inspectClaudeUsage = Effect.fn("inspectClaudeUsage")(function* (
  timeout: Duration.Input = "10 seconds",
) {
  const queries = yield* ClaudeUsageQueries;
  return yield* Effect.acquireUseRelease(
    Effect.suspend(() => {
      const abortController = new AbortController();
      return queries
        .start(abortController)
        .pipe(Effect.map((usageQuery) => ({ abortController, usageQuery })));
    }),
    ({ usageQuery }) =>
      Effect.tryPromise({
        try: async () => usageQuery.readUsage(),
        catch: (cause) => new ClaudeUsageInspectionError({ operation: "read", cause }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.fail(
              new ClaudeUsageTimeoutError({ timeout: Duration.fromInputUnsafe(timeout) }),
            ),
        }),
        Effect.flatMap((response) => Effect.fromResult(parseUsageResponse(response))),
      ),
    ({ abortController, usageQuery }) =>
      Effect.sync(() => {
        abortController.abort();
      }).pipe(
        Effect.andThen(Effect.tryPromise(async () => usageQuery.close())),
        Effect.timeout(timeout),
        Effect.mapError((cause) => new ClaudeUsageInspectionError({ operation: "close", cause })),
        // Release runs uninterruptibly; the cleanup timeout must still be able to stop it.
        Effect.interruptible,
      ),
  );
});

function formatResetTime(resetsAt: string | null): string {
  if (resetsAt === null) {
    return "reset time unavailable";
  }
  const formatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return `resets ${formatter.format(new Date(resetsAt))}`;
}

/**
 * Format remaining Claude plan allowances for Pi's notification UI.
 *
 * @param status - Parsed Claude usage status.
 * @returns A concise multi-line usage report.
 */
export function formatClaudeUsageStatus(status: ClaudeUsageStatus): string {
  if (!status.rateLimitsAvailable) {
    return "Claude plan usage is unavailable for the current authentication method.";
  }
  if (status.windows.length === 0) {
    return "Claude returned no plan usage windows.";
  }

  const lines = status.windows.map((window) => {
    const remaining =
      window.usedPercent === null
        ? "remaining usage unavailable"
        : `${100 - window.usedPercent}% remaining`;
    return `${window.name}: ${remaining}, ${formatResetTime(window.resetsAt)}`;
  });
  if (status.extraUsageEnabled !== null) {
    lines.push(`Extra usage: ${status.extraUsageEnabled ? "enabled" : "disabled"}`);
  }
  return lines.join("\n");
}
