import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type {
  AutoResumeHandlers,
  AutoResumeRegistration,
  MarkerRenderer,
  WidgetFactory,
} from "../auto-resume";

type Command = Parameters<AutoResumeRegistration["registerCommand"]>[1];
type Sent = { readonly message: unknown; readonly options: unknown };

const plainTheme = { fg: (_color: string, text: string) => text };

/** Render a component as plain text at a comfortable width. */
function renderText(component: Component): string {
  return component
    .render(120)
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/** A projected assistant message entry with the given stop reason. */
export function assistantEntry(
  id: string,
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): ProjectedSessionEntry {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "partial" }],
    api: "anthropic-messages",
    provider: "claude-sdk",
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
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
  return {
    sourceEntry: { type: "message", id, parentId: null, timestamp: "", message },
    messages: [message],
  };
}

/** A projected user message entry. */
export function userEntry(id: string): ProjectedSessionEntry {
  const message: AgentMessage = { role: "user", content: "go", timestamp: 0 };
  return {
    sourceEntry: { type: "message", id, parentId: null, timestamp: "", message },
    messages: [message],
  };
}

/** Pi double that captures registrations and replays events with a fake context and clock. */
export function fakePi(mode: ExtensionContext["mode"] = "tui", settings: object = {}) {
  const handlers: Partial<AutoResumeHandlers> = {};
  const channels = new Map<string, (data: unknown) => void>();
  const commands = new Map<string, Command>();
  const renderers = new Map<string, MarkerRenderer>();
  const notifications: { message: string; level: string | undefined }[] = [];
  const sent: Sent[] = [];
  const appended: { customType: string; data: unknown }[] = [];
  const stderr: string[] = [];
  const widgets = new Map<string, WidgetFactory>();
  const timers = new Set<() => void>();
  let clock = 0;
  let idle = true;

  let currentSettings = settings;

  const ctx = {
    mode,
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

  const pi: AutoResumeRegistration = {
    on: (name: keyof AutoResumeHandlers, handler: AutoResumeHandlers[keyof AutoResumeHandlers]) => {
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
      appended.push({ customType, data });
    },
    registerMessageRenderer: (customType, renderer) => {
      renderers.set(customType, renderer);
    },
    registerCommand: (name, options) => {
      commands.set(name, options);
    },
  };

  const handler = <K extends keyof AutoResumeHandlers>(name: K): AutoResumeHandlers[K] => {
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
    publish: (channel: string, data: unknown) => {
      channels.get(channel)?.(data);
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
    settle: (outcome: "completed" | "aborted" | "error", contextEntries: ProjectedSessionEntry[]) =>
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
    context: (messages: AgentMessage[]) => handler("context")({ type: "context", messages }),
    shutdown: () => {
      handler("session_shutdown")({ type: "session_shutdown" });
    },
    command: async (args: string) => {
      const command = commands.get("auto-resume");
      if (command === undefined) {
        throw new Error("test setup: no auto-resume command registered");
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
    setSettings: (value: object) => {
      currentSettings = value;
    },
    widgetText: (key: string) => {
      const widget = widgets.get(key);
      return widget === undefined ? undefined : renderText(widget(undefined, plainTheme));
    },
    renderMarker: (content: unknown) => {
      const renderer = renderers.get("auto-resume");
      return renderer === undefined
        ? undefined
        : renderText(renderer({ content }, undefined, plainTheme));
    },
    timerCount: () => timers.size,
    notifications,
    sent,
    appended,
    stderr,
  };
}
