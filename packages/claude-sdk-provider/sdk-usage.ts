import process from "node:process";
import {
  type Query,
  query,
  type SDKControlGetUsageResponse,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
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
        .array(
          z.object({
            display_name: z.string().min(1),
            utilization: z.number().min(0).max(100).nullable(),
            resets_at: z.iso.datetime({ offset: true }).nullable(),
          }),
        )
        .optional(),
      extra_usage: z
        .object({
          is_enabled: z.boolean(),
          monthly_limit: z.number().nullable(),
          used_credits: z.number().nullable(),
          utilization: z.number().min(0).max(100).nullable(),
          currency: z.string().nullable().optional(),
        })
        .nullish(),
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

/** Safe public shape of an expected usage-inspection failure. */
export interface ClaudeUsageInspectionFailure extends Error {
  readonly _tag: "ClaudeUsageInspectionError";
  readonly operation: "start" | "read" | "parse" | "timeout" | "close";
  readonly cause?: unknown;
}

/** Expected failure while reading Claude subscription usage. */
class ClaudeUsageInspectionError extends Error implements ClaudeUsageInspectionFailure {
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

/** Result of reading Claude subscription usage. */
export type ClaudeUsageStatusResult =
  | { readonly _tag: "ok"; readonly value: ClaudeUsageStatus }
  | { readonly _tag: "err"; readonly error: ClaudeUsageInspectionFailure };

/** Minimal live SDK query used by usage inspection. */
export interface ClaudeUsageQuery {
  /** Request the SDK's experimental structured `/usage` response. */
  readonly readUsage: () => Promise<unknown>;
  /** Close the idle SDK session and its subprocess. */
  readonly close: () => Promise<void>;
}

/** Starts an idle, subscription-authenticated SDK query. */
export type StartClaudeUsageQuery = (signal: AbortSignal) => ClaudeUsageQuery;

async function* idlePrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

function defaultStartClaudeUsageQuery(signal: AbortSignal): ClaudeUsageQuery {
  const abortController = new AbortController();
  const forwardAbort = () => abortController.abort(signal.reason);
  if (signal.aborted) forwardAbort();
  else signal.addEventListener("abort", forwardAbort, { once: true });

  let sdkQuery: Query;
  try {
    sdkQuery = query({
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
  } catch (cause) {
    signal.removeEventListener("abort", forwardAbort);
    throw cause;
  }

  return {
    readUsage: (): Promise<SDKControlGetUsageResponse> =>
      sdkQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
    close: async () => {
      signal.removeEventListener("abort", forwardAbort);
      abortController.abort();
      await sdkQuery.return();
    },
  };
}

function parseUsageResponse(input: unknown): ClaudeUsageStatusResult {
  const parsed = usageResponseSchema.safeParse(input);
  if (!parsed.success) {
    return { _tag: "err", error: new ClaudeUsageInspectionError("parse") };
  }

  const limits = parsed.data.rate_limits;
  const windows: ClaudeUsageWindow[] = [];
  if (limits?.five_hour) {
    windows.push({
      name: "Current session",
      usedPercent: limits.five_hour.utilization,
      resetsAt: limits.five_hour.resets_at,
    });
  }
  if (limits?.seven_day) {
    windows.push({
      name: "Weekly",
      usedPercent: limits.seven_day.utilization,
      resetsAt: limits.seven_day.resets_at,
    });
  }
  for (const window of limits?.model_scoped ?? []) {
    windows.push({
      name: `${window.display_name} weekly`,
      usedPercent: window.utilization,
      resetsAt: window.resets_at,
    });
  }

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

/**
 * Read current Claude subscription usage without sending a model prompt.
 *
 * @param startQuery - Injectable SDK subprocess boundary.
 * @param timeoutMilliseconds - Maximum time to wait for the SDK usage response.
 * @returns Parsed usage or a typed startup, read, parse, timeout, or cleanup failure.
 */
export async function inspectClaudeUsage(
  startQuery: StartClaudeUsageQuery = defaultStartClaudeUsageQuery,
  timeoutMilliseconds = 10_000,
): Promise<ClaudeUsageStatusResult> {
  const abortController = new AbortController();
  let usageQuery: ClaudeUsageQuery;
  try {
    usageQuery = startQuery(abortController.signal);
  } catch (cause) {
    return { _tag: "err", error: new ClaudeUsageInspectionError("start", cause) };
  }

  const readOutcome = usageQuery.readUsage().then(
    (value) => ({ _tag: "ok", value }) as const,
    (cause: unknown) => ({ _tag: "err", cause }) as const,
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutOutcome = new Promise<{ readonly _tag: "timeout" }>((resolve) => {
    timeout = setTimeout(() => resolve({ _tag: "timeout" }), timeoutMilliseconds);
  });
  const outcome = await Promise.race([readOutcome, timeoutOutcome]);
  if (timeout !== undefined) clearTimeout(timeout);

  let result: ClaudeUsageStatusResult;
  if (outcome._tag === "ok") result = parseUsageResponse(outcome.value);
  else if (outcome._tag === "err") {
    result = { _tag: "err", error: new ClaudeUsageInspectionError("read", outcome.cause) };
  } else {
    result = { _tag: "err", error: new ClaudeUsageInspectionError("timeout") };
  }

  abortController.abort();
  try {
    await usageQuery.close();
  } catch (cause) {
    if (result._tag === "ok") {
      return { _tag: "err", error: new ClaudeUsageInspectionError("close", cause) };
    }
  }
  return result;
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
