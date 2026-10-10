import { once } from "node:events";
import process from "node:process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Data, Duration, Effect, Result } from "effect";
import { z } from "zod";
import { subscriptionEnvironment } from "./sdk/subscription-environment";

const usageWindowSchema = z.object({
  utilization: z.number().min(0).max(100).nullable(),
  resets_at: z.iso.datetime({ offset: true }).nullable(),
});

const modelScopedWindowSchema = usageWindowSchema.extend({ display_name: z.string().min(1) });
const extraUsageSchema = z.object({ is_enabled: z.boolean() });

const rateLimitsSchema = z.object({
  five_hour: usageWindowSchema.nullish(),
  seven_day: usageWindowSchema.nullish(),
  model_scoped: z.array(modelScopedWindowSchema).optional(),
  extra_usage: extraUsageSchema.nullish(),
});

const usageResponseSchema = z.object({
  subscription_type: z.string().nullable(),
  rate_limits_available: z.boolean(),
  rate_limits: rateLimitsSchema.nullable(),
});

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

const USAGE_FAILURE_MESSAGES = {
  start: "Could not start a Claude session to read usage",
  read: "Claude did not return usage data",
  parse: "Claude returned usage data in an unexpected format",
  close: "Could not close the Claude usage session",
} as const;

/** Expected failure while starting, reading, parsing, or closing a Claude usage session. */
class ClaudeUsageInspectionError extends Data.TaggedError("ClaudeUsageInspectionError")<{
  /** Inspection step that failed. */
  readonly operation: keyof typeof USAGE_FAILURE_MESSAGES;
  /** Unclassified local cause. Callers must not render it. */
  readonly cause?: unknown;
}> {
  /** Plain-English summary of the failed step. */
  override get message(): string {
    return USAGE_FAILURE_MESSAGES[this.operation];
  }
}

/** Expected failure when Claude does not answer the usage request in time. */
class ClaudeUsageTimeoutError extends Data.TaggedError("ClaudeUsageTimeoutError")<{
  /** How long the inspection waited. */
  readonly timeout: Duration.Duration;
}> {
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

function parseUsageResponse(
  input: unknown,
): Result.Result<ClaudeUsageStatus, ClaudeUsageInspectionError> {
  const parsed = usageResponseSchema.safeParse(input);
  if (!parsed.success) {
    return Result.fail(new ClaudeUsageInspectionError({ operation: "parse", cause: parsed.error }));
  }

  const limits = parsed.data.rate_limits;
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
    subscriptionType: parsed.data.subscription_type,
    rateLimitsAvailable: parsed.data.rate_limits_available,
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
 * @param startQuery - Injectable SDK subprocess boundary.
 * @param timeout - Maximum wait for the SDK response, and again for cleanup.
 * @returns Parsed usage, failing with a typed startup, read, parse, timeout, or cleanup error.
 */
export const inspectClaudeUsage = Effect.fn("inspectClaudeUsage")(function* (
  startQuery: StartClaudeUsageQuery = defaultStartClaudeUsageQuery,
  timeout: Duration.Input = "10 seconds",
) {
  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const abortController = new AbortController();
        return { abortController, usageQuery: startQuery(abortController) };
      },
      catch: (cause) => new ClaudeUsageInspectionError({ operation: "start", cause }),
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
