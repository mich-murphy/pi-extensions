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

/**
 * Event-bus channel on which providers publish a usage limit's reset time. Mirrors
 * `USAGE_LIMIT_CHANNEL` in pi-claude-sdk; packages never import each other.
 */
export const USAGE_LIMIT_CHANNEL = "usage-limit";

/** Custom type of the resume marker message and of the reset report in JSON mode. */
export const AUTO_RESUME_TYPE = "auto-resume";

/** Longest wait the extension accepts; a later reset is left to the user. */
export const MAX_WAIT_MS = 5 * 60 * 60 * 1000;

/** How often the wall clock is compared with the reset time while waiting. */
export const CHECK_INTERVAL_MS = 60 * 1000;

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

/** Context fields auto-resume reads from Pi. */
export type AutoResumeContext = Pick<ExtensionContext, "mode" | "isIdle"> & {
  readonly ui: Pick<ExtensionContext["ui"], "notify"> & {
    readonly setWidget: (key: string, content: WidgetFactory | undefined) => void;
  };
};

/** Lifecycle callbacks consumed by auto-resume. */
export type AutoResumeHandlers = {
  agent_start: (event: { readonly type: "agent_start" }) => void;
  turn_start: (event: { readonly type: "turn_start" }) => void;
  session_tree: (event: { readonly type: "session_tree" }) => void;
  agent_before_settle: (
    event: Pick<AgentBeforeSettleEvent, "type" | "outcome" | "context">,
    ctx: AutoResumeContext,
  ) => BoundaryResult | undefined;
  input: (event: Pick<InputEvent, "type" | "source">, ctx: AutoResumeContext) => InputEventResult;
  context: (event: ContextEvent) => ContextEventResult | undefined;
  session_shutdown: (event: { readonly type: "session_shutdown" }) => void;
};

/** Pi capabilities consumed by auto-resume. */
export type AutoResumeRegistration = Pick<ExtensionAPI, "sendMessage" | "appendEntry"> & {
  readonly registerMessageRenderer: (customType: string, renderer: MarkerRenderer) => void;
  readonly events: Pick<ExtensionAPI["events"], "on">;
  readonly registerCommand: (
    name: string,
    options: Pick<RegisteredCommand, "description" | "getArgumentCompletions"> & {
      readonly handler: (args: string, ctx: AutoResumeContext) => Promise<void>;
    },
  ) => void;
  readonly on: {
    (name: "agent_start", handler: AutoResumeHandlers["agent_start"]): unknown;
    (name: "turn_start", handler: AutoResumeHandlers["turn_start"]): unknown;
    (name: "session_tree", handler: AutoResumeHandlers["session_tree"]): unknown;
    (name: "agent_before_settle", handler: AutoResumeHandlers["agent_before_settle"]): unknown;
    (name: "input", handler: AutoResumeHandlers["input"]): unknown;
    (name: "context", handler: AutoResumeHandlers["context"]): unknown;
    (name: "session_shutdown", handler: AutoResumeHandlers["session_shutdown"]): unknown;
  };
};

/** Clock, timer, and output operations owned by the extension runtime. */
export type AutoResumeDependencies = {
  /** Current wall-clock time in epoch milliseconds. */
  readonly now: () => number;
  /** Start a repeating timer and return the function that stops it. */
  readonly every: (intervalMs: number, tick: () => void) => () => void;
  /** Format an epoch-millisecond time as a local clock time, such as `3:40 pm`. */
  readonly formatTime: (epochMs: number) => string;
  /** Write one line of diagnostics to stderr. */
  readonly writeStderr: (line: string) => void;
};

type Wait = {
  readonly resetsAt: number;
  readonly ctx: AutoResumeContext;
  readonly stop: () => void;
};

function readResetsAt(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null || !("resetsAt" in data)) {
    return undefined;
  }
  const { resetsAt } = data;
  return typeof resetsAt === "number" && Number.isFinite(new Date(resetsAt).getTime())
    ? resetsAt
    : undefined;
}

/** The session entry of the run's failed assistant message, when the run ended on one. */
function failedAttemptId(
  event: Pick<AgentBeforeSettleEvent, "context">,
  provider: string | undefined,
): string | undefined {
  const last = event.context.contextEntries.findLast(
    ({ sourceEntry }) => sourceEntry.type === "message" || sourceEntry.type === "custom_message",
  )?.sourceEntry;
  return last?.type === "message" &&
    last.message.role === "assistant" &&
    last.message.stopReason === "error" &&
    (provider === undefined || last.message.provider === provider)
    ? last.id
    : undefined;
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
export function registerAutoResume(
  pi: AutoResumeRegistration,
  dependencies: AutoResumeDependencies,
): void {
  const { now, every, formatTime, writeStderr } = dependencies;
  let enabled = true;
  // Notice published during the current model/tool turn, consumed at final settlement.
  let published: { resetsAt: number; provider: string | undefined } | undefined;
  let wait: Wait | undefined;

  const cancel = (): void => {
    if (wait === undefined) {
      return;
    }
    const { ctx, stop } = wait;
    wait = undefined;
    stop();
    ctx.ui.setWidget(AUTO_RESUME_TYPE, undefined);
  };

  const resume = (): void => {
    if (wait === undefined || now() < wait.resetsAt || !wait.ctx.isIdle()) {
      return;
    }
    const time = formatTime(wait.resetsAt);
    cancel();
    pi.sendMessage(
      {
        customType: AUTO_RESUME_TYPE,
        content: `Auto-resumed after the usage limit reset at ${time}`,
        display: true,
      },
      { triggerTurn: true },
    );
  };

  const startWait = (resetsAt: number, ctx: AutoResumeContext): void => {
    cancel();
    const time = formatTime(resetsAt);
    ctx.ui.notify(`Usage limit reached. Pi will continue automatically at ${time}.`, "warning");
    ctx.ui.setWidget(AUTO_RESUME_TYPE, (_tui, theme) => {
      const reason = theme.fg("muted", `Usage limit reached · auto-resume at ${time} · `);
      return new Text(
        `${theme.fg("warning", "⏸ ")}${reason}${theme.fg("dim", "/auto-resume off to cancel")}`,
        1,
        0,
      );
    });
    wait = { resetsAt, ctx, stop: every(CHECK_INTERVAL_MS, resume) };
  };

  const report = (resetsAt: number, ctx: AutoResumeContext): void => {
    if (ctx.mode === "json") {
      pi.appendEntry(AUTO_RESUME_TYPE, { resetsAt });
    } else {
      writeStderr(`Usage limit resets at ${new Date(resetsAt).toISOString()}`);
    }
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

  pi.registerMessageRenderer(AUTO_RESUME_TYPE, renderMarker);

  pi.on("agent_start", () => {
    cancel();
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
  });

  pi.on("agent_before_settle", (event, ctx) => {
    const notice = published;
    published = undefined;
    const targetId =
      event.outcome === "error" ? failedAttemptId(event, notice?.provider) : undefined;
    if (notice === undefined || targetId === undefined) {
      return undefined;
    }
    const { resetsAt } = notice;
    if (ctx.mode === "print" || ctx.mode === "json") {
      report(resetsAt, ctx);
      return undefined;
    }
    const delay = resetsAt - now();
    if (!enabled || delay <= 0 || delay > MAX_WAIT_MS) {
      return undefined;
    }
    startWait(resetsAt, ctx);
    return { entries: [{ type: "context_edit", targetId, replacement: null }] };
  });

  pi.on("input", (event, ctx) => {
    if (wait !== undefined && event.source !== "extension") {
      cancel();
      ctx.ui.notify("Auto-resume cancelled: your new prompt takes over.", "info");
    }
    return { action: "continue" };
  });

  pi.on("context", (event) => {
    const messages = event.messages.filter(
      (message) => message.role !== "custom" || message.customType !== AUTO_RESUME_TYPE,
    );
    return messages.length === event.messages.length ? undefined : { messages };
  });

  pi.on("session_shutdown", () => {
    cancel();
    published = undefined;
  });

  pi.registerCommand(AUTO_RESUME_TYPE, {
    description: "Turn automatic resume after usage limits on or off for this session",
    getArgumentCompletions: (prefix) =>
      ["on", "off"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const choice = args.trim();
      if (choice !== "" && choice !== "on" && choice !== "off") {
        ctx.ui.notify("Usage: /auto-resume [on|off]", "warning");
        return;
      }
      enabled = choice === "" ? !enabled : choice === "on";
      if (!enabled) {
        cancel();
      }
      ctx.ui.notify(`Auto-resume is ${enabled ? "on" : "off"} for this session.`, "info");
    },
  });
}
