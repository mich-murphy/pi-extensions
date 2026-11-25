import { once } from "node:events";
import process from "node:process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Context, Duration, Effect, Layer, Result, Schema } from "effect";
import { resolveClaudeExecutable } from "./sdk/claude-executable";
import { subscriptionEnvironment } from "./sdk/subscription-environment";

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
  seven_day_oauth_apps: Schema.optional(Schema.NullOr(usageWindowSchema)),
  seven_day_opus: Schema.optional(Schema.NullOr(usageWindowSchema)),
  seven_day_sonnet: Schema.optional(Schema.NullOr(usageWindowSchema)),
  model_scoped: Schema.optional(Schema.Array(modelScopedWindowSchema)),
  extra_usage: Schema.optional(Schema.NullOr(Schema.Struct({ is_enabled: Schema.Boolean }))),
});

export const decodeUsageResponse = Schema.decodeUnknownResult(
  Schema.Struct({
    subscription_type: Schema.NullOr(Schema.String),
    rate_limits_available: Schema.Boolean,
    rate_limits: Schema.NullOr(rateLimitsSchema),
  }),
);

export type ClaudeUsageWindow = {
  readonly name: string;
  readonly usedPercent: number | null;
  readonly resetsAt: string | null;
};

export type ClaudeUsageStatus = {
  readonly subscriptionType: string | null;
  readonly rateLimitsAvailable: boolean;
  readonly windows: readonly ClaudeUsageWindow[];
  readonly extraUsageEnabled: boolean | null;
};

const UsageInspectionOperation = Schema.Literals(["start", "read", "parse", "close"]);

const USAGE_FAILURE_MESSAGES: Readonly<Record<typeof UsageInspectionOperation.Type, string>> = {
  start: "Could not start a Claude session to read usage.",
  read: "Claude did not return usage data.",
  parse: "Claude returned usage data in a format pi-claude does not recognize.",
  close: "Could not close the Claude usage session. Restart Pi if `claude` keeps running.",
};

class ClaudeUsageInspectionError extends Schema.TaggedError<ClaudeUsageInspectionError>()(
  "ClaudeUsageInspectionError",
  {
    operation: UsageInspectionOperation,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return USAGE_FAILURE_MESSAGES[this.operation];
  }
}

class ClaudeUsageTimeoutError extends Schema.TaggedError<ClaudeUsageTimeoutError>()(
  "ClaudeUsageTimeoutError",
  {
    timeout: Schema.Duration,
  },
) {
  override get message(): string {
    return `Timed out after ${Duration.format(this.timeout)} waiting for Claude usage.`;
  }
}

export type ClaudeUsageQuery = {
  readonly readUsage: () => Promise<ReturnType<typeof decodeUsageResponse>>;
  readonly close: () => Promise<void>;
};

export type StartClaudeUsageQuery = (abortController: AbortController) => ClaudeUsageQuery;

// oxlint-disable-next-line eslint/require-yield -- The idle prompt sends no message; it only holds SDK input open until abort.
async function* idlePrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  if (signal.aborted) {
    return;
  }
  await once(signal, "abort");
}

function requireClaudeExecutable(): string {
  const executable = resolveClaudeExecutable(process.env);
  if (executable === undefined) {
    throw new Error("claude executable not found");
  }
  return executable;
}

function defaultStartClaudeUsageQuery(abortController: AbortController): ClaudeUsageQuery {
  const sdkQuery = query({
    prompt: idlePrompt(abortController.signal),
    options: {
      abortController,
      cwd: process.cwd(),
      pathToClaudeCodeExecutable: requireClaudeExecutable(),
      env: { ...subscriptionEnvironment() },
      persistSession: false,
      settingSources: [],
      tools: [],
      strictMcpConfig: true,
      skills: [],
    },
  });
  return {
    readUsage: async () =>
      decodeUsageResponse(
        await sdkQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      ),
    close: async () => {
      await sdkQuery.return();
    },
  };
}

export class ClaudeUsageQueries extends Context.Service<
  ClaudeUsageQueries,
  {
    readonly start: (
      abortController: AbortController,
    ) => Effect.Effect<ClaudeUsageQuery, ClaudeUsageInspectionError>;
  }
>()("pi-claude/sdk-usage/ClaudeUsageQueries") {
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

  static readonly layer: Layer.Layer<ClaudeUsageQueries> = ClaudeUsageQueries.fromStart(
    defaultStartClaudeUsageQuery,
  );
}

function parseUsageResponse(
  parsed: ReturnType<typeof decodeUsageResponse>,
): Result.Result<ClaudeUsageStatus, ClaudeUsageInspectionError> {
  if (Result.isFailure(parsed)) {
    return Result.fail(
      new ClaudeUsageInspectionError({ operation: "parse", cause: parsed.failure }),
    );
  }

  const limits = parsed.success.rate_limits;
  const reportedWindows = [
    { name: "Current session", window: limits?.five_hour },
    { name: "All models weekly", window: limits?.seven_day },
    { name: "OAuth apps weekly", window: limits?.seven_day_oauth_apps },
    { name: "Opus weekly", window: limits?.seven_day_opus },
    { name: "Sonnet weekly", window: limits?.seven_day_sonnet },
    ...(limits?.model_scoped ?? []).map((window) => ({
      name: `${window.display_name} weekly`,
      window,
    })),
  ].flatMap(({ name, window }) =>
    window ? [{ name, usedPercent: window.utilization, resetsAt: window.resets_at }] : [],
  );
  const names = new Set<string>();
  const windows = reportedWindows.filter((window) => {
    const name = window.name.toLowerCase();
    if (names.has(name)) {
      return false;
    }
    names.add(name);
    return true;
  });
  return Result.succeed({
    subscriptionType: parsed.success.subscription_type,
    rateLimitsAvailable: parsed.success.rate_limits_available,
    windows,
    extraUsageEnabled: limits?.extra_usage?.is_enabled ?? null,
  });
}

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
        Effect.interruptible,
      ),
  );
});

function remainingPercent(usedPercent: number): number {
  return Math.round((100 - usedPercent) * 100) / 100;
}

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
        : `${remainingPercent(window.usedPercent)}% remaining`;
    return `${window.name}: ${remaining}, ${formatResetTime(window.resetsAt)}`;
  });
  if (status.extraUsageEnabled !== null) {
    lines.push(`Extra usage: ${status.extraUsageEnabled ? "enabled" : "disabled"}`);
  }
  return lines.join("\n");
}
