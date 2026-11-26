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
  MessageRenderOptions,
  MessageRenderer,
  RegisteredCommand,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Result, Schema, SchemaGetter } from "effect";
import { onOffCommand } from "../shared/on-off-command";
import { USAGE_LIMIT_CHANNEL, decodeUsageLimitNotice } from "../shared/usage-limit";
import type { UsageLimitNotice } from "../shared/usage-limit";

export const RETRY_TYPE = "retry";

export const LEGACY_RETRY_TYPE = "auto-resume";

const MARKER_TYPES: ReadonlySet<string> = new Set([RETRY_TYPE, LEGACY_RETRY_TYPE]);

const CLAUDE_PROVIDER_IDS: ReadonlySet<string> = new Set(["claude", "claude-sdk"]);

export const MAX_WAIT_MS = 5 * 60 * 60 * 1000;

export const CHECK_INTERVAL_MS = 60 * 1000;

const MINUTE_MS = 60 * 1000;

const TRANSIENT_ERROR_MESSAGES: ReadonlySet<string> = new Set([
  "Claude Code stopped with an error but did not say why.",
  "Claude Code failed to start with an unexpected error.",
]);

export type TransientSettings = {
  readonly enabled: boolean;
  readonly delaysMinutes: ReadonlyArray<number>;
  readonly maxAttempts: number;
  readonly windowMinutes: number;
};

export const DEFAULT_TRANSIENT_SETTINGS: TransientSettings = {
  enabled: true,
  delaysMinutes: [1, 2, 5, 10, 15],
  maxAttempts: 8,
  windowMinutes: 120,
};

export type ThemeColors = Pick<Theme, "fg">;

export type WidgetFactory = (tui: TUI, theme: ThemeColors) => Component;

export type MarkerRenderer = (
  message: Pick<Parameters<MessageRenderer>[0], "content">,
  options: MessageRenderOptions,
  theme: ThemeColors,
) => Component;

export type RetryContext = Pick<ExtensionContext, "mode" | "isIdle"> & {
  readonly model?: { readonly contextWindow: number } | undefined;
  readonly ui: Pick<ExtensionContext["ui"], "notify"> & {
    readonly setWidget: (key: string, content: WidgetFactory | undefined) => void;
  };
};

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

export type RetryRegistration = Pick<ExtensionAPI, "sendMessage" | "appendEntry"> & {
  readonly getSettings: () => RetrySettingsInput | ReturnType<ExtensionAPI["getSettings"]>;
  readonly registerMessageRenderer: (customType: string, renderer: MarkerRenderer) => void;
  readonly events: Pick<ExtensionAPI["events"], "on">;
  readonly registerCommand: (
    name: string,
    options: Pick<RegisteredCommand, "description" | "getArgumentCompletions"> & {
      readonly handler: (args: string, ctx: RetryContext) => Promise<void>;
    },
  ) => void;
  readonly on: {
    (name: "agent_start", handler: RetryHandlers["agent_start"]): void;
    (name: "turn_start", handler: RetryHandlers["turn_start"]): void;
    (name: "session_tree", handler: RetryHandlers["session_tree"]): void;
    (name: "agent_before_settle", handler: RetryHandlers["agent_before_settle"]): void;
    (name: "input", handler: RetryHandlers["input"]): void;
    (name: "context", handler: RetryHandlers["context"]): void;
    (name: "session_shutdown", handler: RetryHandlers["session_shutdown"]): void;
  };
};

export type RetryDependencies = {
  readonly now: () => number;
  readonly every: (intervalMs: number, tick: () => void) => () => void;
  readonly formatTime: (epochMs: number) => string;
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

export type RetrySettingsInput = {
  readonly piRetry?: unknown;
  readonly autoResume?: unknown;
};

type DataDescriptor = { readonly value?: unknown };

const isSettingsObject = Schema.is(
  Schema.ObjectKeyword.check(Schema.makeFilter((raw) => !Array.isArray(raw))),
);

const ownSettingsObject = Schema.Unknown.pipe(
  Schema.decode({
    decode: SchemaGetter.transform((raw) => {
      if (!isSettingsObject(raw)) {
        return raw;
      }

      const entries = Object.entries(Object.getOwnPropertyDescriptors(raw));

      const fields = Object.fromEntries(
        entries.flatMap(([key, descriptor]: [string, DataDescriptor]) =>
          Object.hasOwn(descriptor, "value") ? [[key, descriptor.value] as const] : [],
        ),
      );

      Object.setPrototypeOf(fields, null);

      return fields;
    }),
    encode: SchemaGetter.transform((value) => value),
  }),
);

const readSettingsSections = Schema.decodeUnknownSync(
  ownSettingsObject.pipe(
    Schema.decodeTo(
      Schema.Struct({
        piRetry: Schema.optional(Schema.Unknown),
        autoResume: Schema.optional(Schema.Unknown),
      }),
    ),
  ),
);

const readRetrySection = Schema.decodeUnknownResult(
  ownSettingsObject.pipe(
    Schema.decodeTo(Schema.Struct({ transient: Schema.optional(Schema.Unknown) })),
  ),
);

const positive = Schema.Finite.check(Schema.isGreaterThan(0));

const readTransientSection = Schema.decodeUnknownResult(
  ownSettingsObject.pipe(
    Schema.decodeTo(
      Schema.Struct({
        enabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
        delaysMinutes: Schema.optional(Schema.NullOr(Schema.NonEmptyArray(positive))),
        maxAttempts: Schema.optional(
          Schema.NullOr(
            Schema.Number.check(Schema.makeFilter(Number.isInteger), Schema.isGreaterThan(0)),
          ),
        ),
        windowMinutes: Schema.optional(Schema.NullOr(positive)),
      }),
    ),
  ),
);

export function readTransientSettings(
  settings: RetrySettingsInput | ReturnType<ExtensionAPI["getSettings"]>,
): TransientSettings | undefined {
  const { piRetry, autoResume } = readSettingsSections(settings);
  const section = readRetrySection(piRetry ?? autoResume ?? {});

  if (Result.isFailure(section)) {
    return undefined;
  }

  const transient = readTransientSection(section.success.transient ?? {});

  if (Result.isFailure(transient)) {
    return undefined;
  }

  const { enabled, delaysMinutes, maxAttempts, windowMinutes } = transient.success;

  return {
    enabled: enabled ?? DEFAULT_TRANSIENT_SETTINGS.enabled,
    delaysMinutes: delaysMinutes ?? DEFAULT_TRANSIENT_SETTINGS.delaysMinutes,
    maxAttempts: maxAttempts ?? DEFAULT_TRANSIENT_SETTINGS.maxAttempts,
    windowMinutes: windowMinutes ?? DEFAULT_TRANSIENT_SETTINGS.windowMinutes,
  };
}

function isTransientFailure(message: AssistantMessage, contextWindow?: number): boolean {
  return (
    (isRetryableAssistantError(message) && !isContextOverflow(message, contextWindow)) ||
    TRANSIENT_ERROR_MESSAGES.has(message.errorMessage ?? "")
  );
}

function sameProvider(notice: string, failed: string): boolean {
  return notice === failed || (CLAUDE_PROVIDER_IDS.has(notice) && CLAUDE_PROVIDER_IDS.has(failed));
}

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
    theme.fg("dim", `↻ ${Schema.is(Schema.String)(message.content) ? message.content : ""}`),
    1,
    0,
  );

export function registerRetry(pi: RetryRegistration, dependencies: RetryDependencies): void {
  const { now, every, formatTime, writeStderr } = dependencies;
  let enabled = true;
  let publishedThisTurn: UsageLimitNotice | undefined;
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
    const notice = decodeUsageLimitNotice(data);
    publishedThisTurn = Result.isSuccess(notice) ? notice.success : undefined;
  });

  for (const type of MARKER_TYPES) {
    pi.registerMessageRenderer(type, renderMarker);
  }

  pi.on("agent_start", () => {
    cancel();
    publishedThisTurn = undefined;
  });

  pi.on("turn_start", () => {
    publishedThisTurn = undefined;
  });

  pi.on("session_tree", () => {
    cancel();
    publishedThisTurn = undefined;
    streak = undefined;
  });

  pi.on("agent_before_settle", (event, ctx) => {
    const notice = publishedThisTurn;
    publishedThisTurn = undefined;

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
    publishedThisTurn = undefined;
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
