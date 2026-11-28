import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionContext,
  ProjectedSessionEntry,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type {
  RetryHandlers,
  RetryRegistration,
  MarkerRenderer,
  RetrySettingsInput,
  WidgetFactory,
} from "../retry";

type Command = Parameters<RetryRegistration["registerCommand"]>[1];

type Sent = {
  readonly message: Parameters<RetryRegistration["sendMessage"]>[0];
  readonly options: Parameters<RetryRegistration["sendMessage"]>[1];
};

export type TestUsageNotice = {
  readonly provider?: string;
  readonly resetsAt?: number | string;
} | null;

const renderOptions = {
  expanded: false,
  outputPad: 0,
  keyText: () => "",
  keyHint: () => "",
} satisfies Parameters<MarkerRenderer>[1];

const tui = new TuiAltScreen(new ProcessTerminal());
const plainTheme = { fg: (_color: string, text: string) => text };

function renderText(component: Component): string {
  return component
    .render(120)
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

export function assistantEntry(
  id: string,
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
  provider = "claude",
): ProjectedSessionEntry {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "partial" }],
    api: "anthropic-messages",
    provider,
    model: "claude",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };

  if (errorMessage !== undefined) {
    message.errorMessage = errorMessage;
  }

  return {
    sourceEntry: { type: "message", id, parentId: null, timestamp: "", message },
    messages: [message],
  };
}

export function userEntry(id: string): ProjectedSessionEntry {
  const message: AgentMessage = { role: "user", content: "go", timestamp: 0 };

  return {
    sourceEntry: { type: "message", id, parentId: null, timestamp: "", message },
    messages: [message],
  };
}

export function fakePi(
  mode: ExtensionContext["mode"] = "tui",
  settings: RetrySettingsInput = {},
  sessionManager = SessionManager.inMemory(),
) {
  const handlers: Partial<RetryHandlers> = {};
  const channels = new Map<string, Parameters<RetryRegistration["events"]["on"]>[1]>();
  const commands = new Map<string, Command>();
  const renderers = new Map<string, MarkerRenderer>();
  const notifications: Array<{ message: string; level: string | undefined }> = [];
  const sent: Array<Sent> = [];
  const appended: Array<{ customType: string; data: unknown }> = [];
  const stderr: Array<string> = [];
  const widgets = new Map<string, WidgetFactory>();
  const timers = new Set<() => void>();
  let clock = 0;
  let idle = true;

  let currentSettings = settings;

  const ctx = {
    mode,
    sessionManager,
    model: { contextWindow: 200_000 },
    isIdle: () => idle,
    ui: {
      notify: (message: string, level?: string) => {
        notifications.push({ message, level });
      },
      setWidget: (key: string, content: WidgetFactory | undefined) => {
        if (content === undefined) {
          widgets.delete(key);
        } else {
          widgets.set(key, content);
        }
      },
    },
  };

  const pi: RetryRegistration = {
    on: (name: keyof RetryHandlers, handler: RetryHandlers[keyof RetryHandlers]) => {
      Object.assign(handlers, { [name]: handler });
    },
    events: {
      on: (channel, handler) => {
        channels.set(channel, handler);

        return () => channels.delete(channel);
      },
    },
    getSettings: () => structuredClone(currentSettings),
    sendMessage: (message, options) => {
      sent.push({ message, options });
    },
    appendEntry: (customType, data) => {
      sessionManager.appendCustomEntry(customType, data);
      appended.push({ customType, data });
    },
    registerMessageRenderer: (customType, renderer) => {
      renderers.set(customType, renderer);
    },
    registerCommand: (name, options) => {
      commands.set(name, options);
    },
  };

  const handler = <K extends keyof RetryHandlers>(name: K): RetryHandlers[K] => {
    const registered = handlers[name];

    if (registered === undefined) {
      throw new Error(`test setup: no ${name} handler registered`);
    }

    return registered;
  };

  return {
    pi,
    deps: {
      now: () => clock,
      every: (_intervalMs: number, tick: () => void) => {
        timers.add(tick);

        return () => {
          timers.delete(tick);
        };
      },
      formatTime: (epochMs: number) => `t+${String(epochMs / 60_000)}m`,
      writeStderr: (line: string) => {
        stderr.push(line);
      },
    },
    publish: (channel: string, data: TestUsageNotice) => {
      channels.get(channel)?.(data);
    },
    startSession: (reason: SessionStartEvent["reason"] = "startup") => {
      handlers.session_start?.({ type: "session_start", reason }, ctx);
    },
    startRun: () => {
      handler("agent_start")({ type: "agent_start" });
      handler("turn_start")({ type: "turn_start" });
    },
    startTurn: () => {
      handler("turn_start")({ type: "turn_start" });
    },
    navigateTree: () => {
      handler("session_tree")({ type: "session_tree" });
    },
    settle: (
      outcome: "completed" | "aborted" | "error",
      contextEntries: Array<ProjectedSessionEntry>,
    ) =>
      handler("agent_before_settle")(
        {
          type: "agent_before_settle",
          outcome,
          context: {
            contextEntries,
            contextMessages: [],
            llmMessages: [],
            pendingMessages: [],
            canContinue: true,
          },
        },
        ctx,
      ),
    input: (source: "interactive" | "rpc" | "extension") =>
      handler("input")({ type: "input", source }, ctx),
    context: (messages: Array<AgentMessage>) => handler("context")({ type: "context", messages }),
    shutdown: () => {
      handler("session_shutdown")({ type: "session_shutdown" });
    },
    command: async (args: string) => {
      const command = commands.get("retry");

      if (command === undefined) {
        throw new Error("test setup: no retry command registered");
      }

      await command.handler(args, ctx);

      return command;
    },
    advanceTo: (time: number) => {
      clock = time;

      for (const tick of timers) {
        tick();
      }
    },
    setIdle: (value: boolean) => {
      idle = value;
    },
    setSettings: (value: RetrySettingsInput) => {
      currentSettings = value;
    },
    widgetText: (key: string) => {
      const widget = widgets.get(key);

      return widget === undefined ? undefined : renderText(widget(tui, plainTheme));
    },
    renderMarker: (content: Parameters<MarkerRenderer>[0]["content"], customType = "retry") => {
      const renderer = renderers.get(customType);

      return renderer === undefined
        ? undefined
        : renderText(renderer({ content }, renderOptions, plainTheme));
    },
    timerCount: () => timers.size,
    notifications,
    sent,
    appended,
    stderr,
  };
}
