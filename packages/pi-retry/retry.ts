import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentBeforeSettleEvent,
  BoundaryResult,
  ContextEvent,
  ContextEventResult,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  RegisteredCommand,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { onOffCommand } from "../shared/on-off-command";

/**
 * Event-bus channel on which providers publish a usage limit's reset time. Mirrors
 * `USAGE_LIMIT_CHANNEL` in pi-claude; packages never import each other.
 */
export const USAGE_LIMIT_CHANNEL = "usage-limit";

/** Custom type of the resume marker message and of the reset report in JSON mode. */
export const RETRY_TYPE = "retry";

/** Custom type that saved sessions from before the rename still contain. */
export const LEGACY_RETRY_TYPE = "auto-resume";

/** Marker types this extension renders and keeps out of model context. */
const MARKER_TYPES: ReadonlySet<string> = new Set([RETRY_TYPE, LEGACY_RETRY_TYPE]);

/** Provider ids that name the same Claude provider before and after its rename. */
const CLAUDE_PROVIDER_IDS: ReadonlySet<string> = new Set(["claude", "claude-sdk"]);

/** Longest wait the extension accepts; a later reset is left to the user. */
export const MAX_WAIT_MS = 5 * 60 * 60 * 1000;

/** How often the wall clock is compared with the reset time while waiting. */
export const CHECK_INTERVAL_MS = 60 * 1000;

const MINUTE_MS = 60 * 1000;

/** Claude Agent SDK failures that {@link isRetryableAssistantError} does not recognise. */
const TRANSIENT_ERROR_MESSAGES: ReadonlySet<string> = new Set([
  "Claude Code stopped with an error but did not say why.",
  "Claude Code failed to start with an unexpected error.",
]);

/** `piRetry.transient` settings: backoff after transient provider or network failures. */
export type TransientSettings = {
  readonly enabled: boolean;
  /** Wait before each attempt; the last delay repeats. */
  readonly delaysMinutes: readonly number[];
  readonly maxAttempts: number;
  /** No attempt is scheduled later than this long after the first failure. */
  readonly windowMinutes: number;
};

export const DEFAULT_TRANSIENT_SETTINGS: TransientSettings = {
  enabled: true,
  delaysMinutes: [1, 2, 5, 10, 15],
  maxAttempts: 8,
  windowMinutes: 120,
};

/** Theme colours the widget and marker use. */
export type ThemeColors = Pick<Theme, "fg">;

/** Renders the widget shown above the editor while a resume is scheduled. */
export type WidgetFactory = (tui: unknown, theme: ThemeColors) => Component;

/** Renders the marker message that records an automatic resume in the transcript. */
export type MarkerRenderer = (
  message: { readonly content: unknown },
  options: unknown,
  theme: ThemeColors,
) => Component;

/** Context fields the extension reads from Pi. */
export type RetryContext = Pick<ExtensionContext, "mode" | "isIdle"> & {
  readonly model?: { readonly contextWindow: number } | undefined;
  readonly ui: Pick<ExtensionContext["ui"], "notify"> & {
    readonly setWidget: (key: string, content: WidgetFactory | undefined) => void;
  };
};

/** Lifecycle callbacks consumed by the extension. */
export type RetryHandlers = {
  agent_start: (event: { readonly type: "agent_start" }) => void;
  turn_start: (event: { readonly type: "turn_start" }) => void;
  session_tree: (event: { readonly type: "session_tree" }) => void;
  agent_before_settle: (
    event: Pick<AgentBeforeSettleEvent, "type" | "outcome" | "context">,
    ctx: RetryContext,
  ) => BoundaryResult | undefined;
  input: (event: Pick<InputEvent, "type" | "source">, ctx: RetryContext) => InputEventResult;
  context: (event: ContextEvent) => ContextEventResult | undefined;
  session_shutdown: (event: { readonly type: "session_shutdown" }) => void;
};

/** Pi capabilities consumed by the extension. */
export type RetryRegistration = Pick<ExtensionAPI, "sendMessage" | "appendEntry"> & {
  readonly getSettings: () => object;
  readonly registerMessageRenderer: (customType: string, renderer: MarkerRenderer) => void;
  readonly events: Pick<ExtensionAPI["events"], "on">;
  readonly registerCommand: (
    name: string,
    options: Pick<RegisteredCommand, "description" | "getArgumentCompletions"> & {
      readonly handler: (args: string, ctx: RetryContext) => Promise<void>;
    },
  ) => void;
  readonly on: {
    (name: "agent_start", handler: RetryHandlers["agent_start"]): unknown;
    (name: "turn_start", handler: RetryHandlers["turn_start"]): unknown;
    (name: "session_tree", handler: RetryHandlers["session_tree"]): unknown;
    (name: "agent_before_settle", handler: RetryHandlers["agent_before_settle"]): unknown;
    (name: "input", handler: RetryHandlers["input"]): unknown;
    (name: "context", handler: RetryHandlers["context"]): unknown;
    (name: "session_shutdown", handler: RetryHandlers["session_shutdown"]): unknown;
  };
};

/** Clock, timer, and output operations owned by the extension runtime. */
export type RetryDependencies = {
  /** Current wall-clock time in epoch milliseconds. */
  readonly now: () => number;
  /** Start a repeating timer and return the function that stops it. */
  readonly every: (intervalMs: number, tick: () => void) => () => void;
  /** Format an epoch-millisecond time as a local clock time, such as `3:40 pm`. */
  readonly formatTime: (epochMs: number) => string;
  /** Write one line of diagnostics to stderr. */
  readonly writeStderr: (line: string) => void;
};

type WaitPlan = {
  readonly resetsAt: number;
  readonly reason: "usage-limit" | "transient";
  readonly attempt: number;
};

type Wait = WaitPlan & {
  readonly ctx: RetryContext;
  readonly stop: () => void;
};

type Streak = { readonly attempts: number; readonly firstFailureAt: number };

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(record: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

const INVALID = Symbol("invalid");

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && isPositive(value);
}

function isDelays(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.length > 0 && value.every((delay) => isPositive(delay));
}

function pick<T>(
  record: object,
  key: keyof TransientSettings,
  valid: (value: unknown) => value is T,
): T | typeof INVALID {
  const value = field(record, key) ?? DEFAULT_TRANSIENT_SETTINGS[key];
  return valid(value) ? value : INVALID;
}

/**
 * Read `piRetry.transient` from Pi's merged settings, or the older `autoResume.transient`
 * when `piRetry` is absent.
 *
 * @returns The settings over the defaults, or `undefined` when they are malformed.
 */
export function readTransientSettings(settings: object): TransientSettings | undefined {
  const section = field(settings, "piRetry") ?? field(settings, "autoResume") ?? {};
  const transient = isRecord(section) ? (field(section, "transient") ?? {}) : null;
  if (!isRecord(transient)) {
    return undefined;
  }
  const enabled = pick(transient, "enabled", isBoolean);
  const delaysMinutes = pick(transient, "delaysMinutes", isDelays);
  const maxAttempts = pick(transient, "maxAttempts", isCount);
  const windowMinutes = pick(transient, "windowMinutes", isPositive);
  return enabled === INVALID ||
    delaysMinutes === INVALID ||
    maxAttempts === INVALID ||
    windowMinutes === INVALID
    ? undefined
    : { enabled, delaysMinutes, maxAttempts, windowMinutes };
}

function isTransientFailure(message: AssistantMessage, contextWindow?: number): boolean {
  return (
    (isRetryableAssistantError(message) && !isContextOverflow(message, contextWindow)) ||
    TRANSIENT_ERROR_MESSAGES.has(message.errorMessage ?? "")
  );
}

/** Whether a usage-limit notice's provider is the failed message's provider. */
function sameProvider(notice: string, failed: string): boolean {
  return notice === failed || (CLAUDE_PROVIDER_IDS.has(notice) && CLAUDE_PROVIDER_IDS.has(failed));
}

function readResetsAt(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null || !("resetsAt" in data)) {
    return undefined;
  }
  const { resetsAt } = data;
  return typeof resetsAt === "number" && Number.isFinite(new Date(resetsAt).getTime())
    ? resetsAt
    : undefined;
}

/** The run's failed assistant message and its session entry, when the run ended on one. */
function failedAttempt(
  event: Pick<AgentBeforeSettleEvent, "context">,
): { readonly id: string; readonly message: AssistantMessage } | undefined {
  const last = event.context.contextEntries.findLast(
    ({ sourceEntry }) => sourceEntry.type === "message" || sourceEntry.type === "custom_message",
  )?.sourceEntry;
  return last?.type === "message" &&
    last.message.role === "assistant" &&
    last.message.stopReason === "error"
    ? { id: last.id, message: last.message }
    : undefined;
}

function omit(targetId: string): BoundaryResult {
  return { entries: [{ type: "context_edit", targetId, replacement: null }] };
}

const renderMarker: MarkerRenderer = (message, _options, theme) =>
  new Text(
    theme.fg("dim", `↻ ${typeof message.content === "string" ? message.content : ""}`),
    1,
    0,
  );

/**
 * Resume a session automatically once a provider's usage limit resets.
 *
 * A provider publishes the reset time on {@link USAGE_LIMIT_CHANNEL} before its failed turn
 * ends. When the run settles on that failure and the reset is at most {@link MAX_WAIT_MS}
 * away, the failed attempt is omitted from model context, Pi settles as usual, and a
 * background timer starts the next turn once the wall clock passes the reset. Comparing the
 * wall clock, rather than sleeping for the whole wait, keeps the resume on time across
 * machine sleep. Print and JSON modes exit when Pi settles, so they only report the reset.
 *
 * @param pi - Pi extension API used to subscribe to events and start the resumed turn.
 * @param dependencies - Clock, timer, and output operations.
 */
export function registerRetry(pi: RetryRegistration, dependencies: RetryDependencies): void {
  const { now, every, formatTime, writeStderr } = dependencies;
  let enabled = true;
  // Notice published during the current model/tool turn, consumed at final settlement.
  let published: { resetsAt: number; provider: string | undefined } | undefined;
  let wait: Wait | undefined;
  let streak: Streak | undefined;
  let warnedAboutSettings = false;

  const cancel = (): void => {
    if (wait === undefined) {
      return;
    }
    const { ctx, stop } = wait;
    wait = undefined;
    stop();
    ctx.ui.setWidget(RETRY_TYPE, undefined);
  };

  const resume = (): void => {
    if (wait === undefined || now() < wait.resetsAt || !wait.ctx.isIdle()) {
      return;
    }
    const { reason, attempt, resetsAt } = wait;
    const content =
      reason === "usage-limit"
        ? `Retried after the usage limit reset at ${formatTime(resetsAt)}`
        : `Retried after a transient provider error (attempt ${String(attempt)})`;
    cancel();
    pi.sendMessage({ customType: RETRY_TYPE, content, display: true }, { triggerTurn: true });
  };

  const startWait = (plan: WaitPlan, ctx: RetryContext): void => {
    cancel();
    const time = formatTime(plan.resetsAt);
    const [notice, label] =
      plan.reason === "usage-limit"
        ? [
            `Usage limit reached. Pi will continue at ${time}; \`/retry off\` cancels.`,
            "Usage limit reached",
          ]
        : [
            `Provider error. Pi will retry at ${time} (attempt ${String(plan.attempt)}); \`/retry off\` cancels.`,
            `Provider error · attempt ${String(plan.attempt)}`,
          ];
    ctx.ui.notify(notice, "warning");
    ctx.ui.setWidget(RETRY_TYPE, (_tui, theme) => {
      const reason = theme.fg("muted", `${label} · retry at ${time} · `);
      return new Text(
        `${theme.fg("warning", "⏸ ")}${reason}${theme.fg("dim", "/retry off to cancel")}`,
        1,
        0,
      );
    });
    wait = { ...plan, ctx, stop: every(CHECK_INTERVAL_MS, resume) };
  };

  const report = (resetsAt: number, ctx: RetryContext): void => {
    if (ctx.mode === "json") {
      pi.appendEntry(RETRY_TYPE, { resetsAt });
    } else {
      writeStderr(`Usage limit resets at ${new Date(resetsAt).toISOString()}`);
    }
  };

  const transientSettings = (ctx: RetryContext): TransientSettings => {
    const settings = readTransientSettings(pi.getSettings());
    if (settings !== undefined) {
      return settings;
    }
    if (!warnedAboutSettings) {
      warnedAboutSettings = true;
      ctx.ui.notify("Invalid piRetry.transient settings; using the defaults.", "warning");
    }
    return DEFAULT_TRANSIENT_SETTINGS;
  };

  const afterUsageLimit = (
    resetsAt: number,
    targetId: string,
    ctx: RetryContext,
  ): BoundaryResult | undefined => {
    if (ctx.mode === "print" || ctx.mode === "json") {
      report(resetsAt, ctx);
      return undefined;
    }
    const delay = resetsAt - now();
    if (!enabled || delay <= 0 || delay > MAX_WAIT_MS) {
      return undefined;
    }
    startWait({ resetsAt, reason: "usage-limit", attempt: 0 }, ctx);
    return omit(targetId);
  };

  const afterTransientFailure = (
    failed: { readonly id: string; readonly message: AssistantMessage },
    ctx: RetryContext,
  ): BoundaryResult | undefined => {
    if (
      !enabled ||
      (ctx.mode !== "tui" && ctx.mode !== "rpc") ||
      !isTransientFailure(failed.message, ctx.model?.contextWindow)
    ) {
      return undefined;
    }
    const settings = transientSettings(ctx);
    if (!settings.enabled) {
      return undefined;
    }
    const current = now();
    const attempt = (streak?.attempts ?? 0) + 1;
    const firstFailureAt = streak?.firstFailureAt ?? current;
    const { delaysMinutes, maxAttempts, windowMinutes } = settings;
    const delayMinutes = delaysMinutes[Math.min(attempt, delaysMinutes.length) - 1] ?? 0;
    const resetsAt = current + delayMinutes * MINUTE_MS;
    if (attempt > maxAttempts || resetsAt > firstFailureAt + windowMinutes * MINUTE_MS) {
      streak = undefined;
      ctx.ui.notify(
        `Provider error persists after ${String(attempt - 1)} automatic retries. Send a message to continue.`,
        "warning",
      );
      return undefined;
    }
    streak = { attempts: attempt, firstFailureAt };
    startWait({ resetsAt, reason: "transient", attempt }, ctx);
    return omit(failed.id);
  };

  pi.events.on(USAGE_LIMIT_CHANNEL, (data) => {
    const resetsAt = readResetsAt(data);
    const provider =
      typeof data === "object" &&
      data !== null &&
      "provider" in data &&
      typeof data.provider === "string"
        ? data.provider
        : undefined;
    published = resetsAt === undefined ? undefined : { resetsAt, provider };
  });

  for (const type of MARKER_TYPES) {
    pi.registerMessageRenderer(type, renderMarker);
  }

  // agent_start deliberately keeps the streak: the extension's own sendMessage triggers it, and
  // resetting there would erase the attempt count between every retry.
  pi.on("agent_start", () => {
    cancel();
    // Normally redundant with turn_start, which follows immediately; kept so a run never
    // inherits a notice published before it began.
    published = undefined;
  });

  // A low-level run can contain multiple model/tool turns. A nested provider call in
  // tools must not donate its notice to the next main request's unrelated failure.
  pi.on("turn_start", () => {
    published = undefined;
  });

  pi.on("session_tree", () => {
    cancel();
    published = undefined;
    // A branch is a different conversation: its failures must not inherit this streak.
    streak = undefined;
  });

  pi.on("agent_before_settle", (event, ctx) => {
    const notice = published;
    published = undefined;
    if (event.outcome === "completed") {
      streak = undefined;
      return undefined;
    }
    const failed = event.outcome === "error" ? failedAttempt(event) : undefined;
    if (failed === undefined) {
      return undefined;
    }
    if (notice === undefined) {
      return afterTransientFailure(failed, ctx);
    }
    return notice.provider === undefined || sameProvider(notice.provider, failed.message.provider)
      ? afterUsageLimit(notice.resetsAt, failed.id, ctx)
      : undefined;
  });

  pi.on("input", (event, ctx) => {
    if (event.source === "extension") {
      return { action: "continue" };
    }
    streak = undefined;
    if (wait !== undefined) {
      cancel();
      ctx.ui.notify("Retry cancelled: your new prompt takes over.", "info");
    }
    return { action: "continue" };
  });

  pi.on("context", (event) => {
    const messages = event.messages.filter(
      (message) => message.role !== "custom" || !MARKER_TYPES.has(message.customType),
    );
    return messages.length === event.messages.length ? undefined : { messages };
  });

  pi.on("session_shutdown", () => {
    cancel();
    published = undefined;
    streak = undefined;
  });

  pi.registerCommand(
    RETRY_TYPE,
    onOffCommand<RetryContext>({
      name: RETRY_TYPE,
      label: "Retry",
      description:
        "Turn automatic retry after usage limits and transient provider errors on or off for this session",
      enabled: () => enabled,
      apply: (next) => {
        enabled = next;
        if (!enabled) {
          cancel();
        }
      },
    }),
  );
}
