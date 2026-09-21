import process from "node:process";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { subscriptionEnvironment } from "./sdk/subscription-environment";

const usageWindowSchema = z.object({
  utilization: z.number().min(0).max(100).nullable(),
  resets_at: z.iso.datetime({ offset: true }).nullable(),
});

const usageResponseSchema = z.object({
  subscription_type: z.string().nullable(),
  rate_limits_available: z.boolean(),
  rate_limits: z
    .object({
      five_hour: usageWindowSchema.nullish(),
      seven_day: usageWindowSchema.nullish(),
      model_scoped: z
        .array(usageWindowSchema.extend({ display_name: z.string().min(1) }))
        .optional(),
      extra_usage: z.object({ is_enabled: z.boolean() }).nullish(),
    })
    .nullable(),
});

/** One Claude subscription rate-limit window. */
export interface ClaudeUsageWindow {
  /** Human-readable window name supplied by this adapter or by Claude. */
  readonly name: string;
  /** Percentage of the allowance consumed, when Claude reports it. */
  readonly usedPercent: number | null;
  /** ISO timestamp at which the allowance resets, when Claude reports it. */
  readonly resetsAt: string | null;
}

/** Parsed Claude subscription usage suitable for display. */
export interface ClaudeUsageStatus {
  /** Claude subscription type, or null outside subscription authentication. */
  readonly subscriptionType: string | null;
  /** Whether Claude returned plan rate limits for this account. */
  readonly rateLimitsAvailable: boolean;
  /** General and model-specific plan windows. */
  readonly windows: ReadonlyArray<ClaudeUsageWindow>;
  /** Whether paid extra usage is enabled. */
  readonly extraUsageEnabled: boolean | null;
}

/** Expected failure while reading Claude subscription usage. */
class ClaudeUsageInspectionError extends Error {
  readonly _tag = "ClaudeUsageInspectionError" as const;

  /**
   * Create a safe usage-inspection failure.
   *
   * @param operation - Inspection step that failed.
   * @param cause - Unclassified local cause. Callers must not render it.
   */
  constructor(
    readonly operation: "start" | "read" | "parse" | "timeout" | "close",
    override readonly cause?: unknown,
  ) {
    super(`Could not ${operation} Claude usage inspection`);
    this.name = "ClaudeUsageInspectionError";
  }
}

export type { ClaudeUsageInspectionError };

/** Result of reading Claude subscription usage. */
export type ClaudeUsageStatusResult =
  | { readonly _tag: "ok"; readonly value: ClaudeUsageStatus }
  | { readonly _tag: "err"; readonly error: ClaudeUsageInspectionError };

/** Minimal live SDK query used by usage inspection. */
export interface ClaudeUsageQuery {
  /** Request the SDK's experimental structured `/usage` response. */
  readonly readUsage: () => Promise<unknown>;
  /** Close the idle SDK session and its subprocess. */
  readonly close: () => Promise<void>;
}

/** Starts an idle, subscription-authenticated SDK query that ends when the controller aborts. */
export type StartClaudeUsageQuery = (abortController: AbortController) => ClaudeUsageQuery;

async function* idlePrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
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
    readUsage: () => sdkQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
    close: async () => {
      await sdkQuery.return();
    },
  };
}

function parseUsageResponse(input: unknown): ClaudeUsageStatusResult {
  const parsed = usageResponseSchema.safeParse(input);
  if (!parsed.success) return { _tag: "err", error: new ClaudeUsageInspectionError("parse") };

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
  return {
    _tag: "ok",
    value: {
      subscriptionType: parsed.data.subscription_type,
      rateLimitsAvailable: parsed.data.rate_limits_available,
      windows,
      extraUsageEnabled: limits?.extra_usage?.is_enabled ?? null,
    },
  };
}

type Settled<T> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "err"; readonly cause: unknown }
  | { readonly _tag: "timeout" };

async function settleWithin<T>(promise: Promise<T>, milliseconds: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ _tag: "timeout" }), milliseconds);
  });
  const settled = promise.then(
    (value): Settled<T> => ({ _tag: "ok", value }),
    (cause: unknown): Settled<T> => ({ _tag: "err", cause }),
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read current Claude subscription usage without sending a model prompt.
 *
 * @param startQuery - Injectable SDK subprocess boundary.
 * @param timeoutMilliseconds - Maximum wait for the SDK response, and again for cleanup.
 * @returns Parsed usage or a typed startup, read, parse, timeout, or cleanup failure.
 */
export async function inspectClaudeUsage(
  startQuery: StartClaudeUsageQuery = defaultStartClaudeUsageQuery,
  timeoutMilliseconds = 10_000,
): Promise<ClaudeUsageStatusResult> {
  const abortController = new AbortController();
  let usageQuery: ClaudeUsageQuery;
  try {
    usageQuery = startQuery(abortController);
  } catch (cause) {
    return { _tag: "err", error: new ClaudeUsageInspectionError("start", cause) };
  }

  const read = await settleWithin(usageQuery.readUsage(), timeoutMilliseconds);
  abortController.abort();
  const closed = await settleWithin(usageQuery.close(), timeoutMilliseconds);

  if (read._tag === "timeout")
    return { _tag: "err", error: new ClaudeUsageInspectionError("timeout") };
  if (read._tag === "err") {
    return { _tag: "err", error: new ClaudeUsageInspectionError("read", read.cause) };
  }
  const result = parseUsageResponse(read.value);
  if (result._tag === "err" || closed._tag === "ok") return result;
  const cause =
    closed._tag === "err" ? closed.cause : new Error("Claude usage query cleanup timed out");
  return { _tag: "err", error: new ClaudeUsageInspectionError("close", cause) };
}

function formatResetTime(resetsAt: string | null): string {
  if (resetsAt === null) return "reset time unavailable";
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
  if (status.windows.length === 0) return "Claude returned no plan usage windows.";

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
