import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  MessageEndEvent,
  SessionStartEvent,
  SessionTreeEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { BatchCall } from "../batch.ts";
import type {
  FeedbackContext,
  FeedbackRegistration,
  FeedbackTool,
  NoteRenderer,
} from "../feedback.ts";
import type { FeedbackCommandContext } from "../toggle.ts";

type Command = Parameters<FeedbackRegistration["registerCommand"]>[1];

type StartHandler = (event: ToolExecutionStartEvent) => void;

type SessionStartHandler = (
  event: SessionStartEvent,
  ctx: { sessionManager: SessionManager },
) => void;

type SessionTreeHandler = (event: SessionTreeEvent) => void;

type Handler =
  | EndHandler
  | MessageHandler
  | StartHandler
  | SessionStartHandler
  | SessionTreeHandler;

type Exposure = NonNullable<FeedbackTool["exposure"]>;

type EndHandler = (event: ToolExecutionEndEvent, ctx: FeedbackContext) => Promise<void>;

type MessageHandler = (event: Pick<MessageEndEvent, "message">) => void;

function isEndHandler(name: string, _handler: Handler): _handler is EndHandler {
  return name === "tool_execution_end";
}

function isStartHandler(name: string, _handler: Handler): _handler is StartHandler {
  return name === "tool_execution_start";
}

function isSessionStartHandler(name: string, _handler: Handler): _handler is SessionStartHandler {
  return name === "session_start";
}

function isSessionTreeHandler(name: string, _handler: Handler): _handler is SessionTreeHandler {
  return name === "session_tree";
}

const renderOptions = { expanded: false, keyText: () => "", keyHint: () => "" };
const plainTheme = { fg: (_color: string, text: string) => text };

function renderText(component: Component | undefined): string {
  return (component?.render(200) ?? [])
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

export function fakePi(
  packagesDir: string,
  agentDir = "/home/u/.pi/agent",
  sessionManager = SessionManager.inMemory("/repo", { id: "session-a" }),
  excluded: ReadonlyArray<string> = [],
) {
  const tools: Array<FeedbackTool> = [];
  const extensionTools = new Map<string, { exposure: Exposure; defaultActive: boolean }>();
  const renderers = new Map<string, NoteRenderer>();
  const commands = new Map<string, Command>();
  const endHandlers: Array<EndHandler> = [];
  const messageHandlers: Array<MessageHandler> = [];
  const startHandlers: Array<StartHandler> = [];
  const sessionStartHandlers: Array<SessionStartHandler> = [];
  const sessionTreeHandlers: Array<SessionTreeHandler> = [];
  const notes: Array<{ customType: string; data: unknown }> = [];
  const notifications: Array<{ message: string; level: string | undefined }> = [];
  const builtins = ["read", "bash"];
  let active = [...builtins];
  let pending = new Set<string>();
  let restored = new Set<string>();
  let appendError: Error | undefined;

  const isRegistered = (name: string): boolean =>
    builtins.includes(name) || (extensionTools.has(name) && !excluded.includes(name));

  const isDeclarable = (name: string): boolean =>
    isRegistered(name) && extensionTools.get(name)?.exposure !== "hidden";

  const isActivatedOnRegistration = (name: string): boolean =>
    isDeclarable(name) && extensionTools.get(name)?.defaultActive !== false;

  const applyLoadout = (names: ReadonlyArray<string>): void => {
    active = [...new Set(names)].filter((name) => isDeclarable(name));

    for (const name of active) {
      pending.delete(name);
    }
  };

  const register = (name: string, exposure: Exposure, defaultActive: boolean): void => {
    const before = isActivatedOnRegistration(name);
    extensionTools.set(name, { exposure, defaultActive });
    const activated = !before && isActivatedOnRegistration(name) ? [name] : [];
    applyLoadout([...active, ...activated, ...pending]);
  };

  const restore = (names: ReadonlyArray<string> | undefined): void => {
    if (names !== undefined) {
      restored = new Set(names);
      pending = new Set(names.filter((name) => !excluded.includes(name)));
      applyLoadout(names);
    }
  };

  const registered = [
    { name: "read", sourceInfo: { path: "builtin:read", source: "builtin" } },
    { name: "bash", sourceInfo: { path: "builtin:bash", source: "builtin" } },
    {
      name: "webfetch",
      sourceInfo: { path: `${packagesDir}/pi-web/index.ts`, source: "local" },
      annotations: { readOnlyHint: true },
    },
    { name: "outside", sourceInfo: { path: "/elsewhere/pi-web/index.ts", source: "local" } },
  ];

  const slashCommands = [
    { name: "skills", sourceInfo: { path: `${packagesDir}/pi-skills/index.ts` } },
    { name: "skill:tidy", sourceInfo: { path: `${agentDir}/skills/tidy/SKILL.md` } },
  ];

  const pi: FeedbackRegistration = {
    registerTool: (tool) => {
      const index = tools.findIndex((known) => known.name === tool.name);
      tools.splice(index === -1 ? tools.length : index, 1, tool);
      register(tool.name, tool.exposure ?? "direct", true);
    },
    registerEntryRenderer: (customType, renderer) => {
      renderers.set(customType, renderer);
    },
    registerCommand: (name, options) => {
      commands.set(name, options);
    },
    on: (name: string, handler: Handler) => {
      if (isSessionStartHandler(name, handler)) {
        sessionStartHandlers.push(handler);
      } else if (isSessionTreeHandler(name, handler)) {
        sessionTreeHandlers.push(handler);
      } else if (isEndHandler(name, handler)) {
        endHandlers.push(handler);
      } else if (isStartHandler(name, handler)) {
        startHandlers.push(handler);
      } else {
        messageHandlers.push(handler);
      }
    },
    appendEntry: (customType, data) => {
      if (appendError !== undefined) {
        throw appendError;
      }

      sessionManager.appendCustomEntry(customType, data);
      notes.push({ customType, data });
    },
    getAllTools: () => [
      ...registered,
      ...tools.flatMap((tool) =>
        isRegistered(tool.name)
          ? [
              {
                name: tool.name,
                sourceInfo: { path: `${packagesDir}/pi-feedback/index.ts`, source: "local" },
              },
            ]
          : [],
      ),
    ],
    getCommands: () => slashCommands,
    getActiveTools: () => [...active],
    setActiveTools: (names) => {
      const previous = active;
      applyLoadout(names);

      if (previous.some((name) => !active.includes(name) && restored.has(name))) {
        pending.clear();
      }
    },
  };

  const ctx = (): FeedbackContext => ({
    sessionManager: { getSessionId: () => sessionManager.getSessionId() },
    model: { provider: "claude", id: "claude-opus-5-5" },
  });

  const commandCtx: FeedbackCommandContext = {
    sessionManager,
    ui: {
      notify: (message, level) => {
        notifications.push({ message, level });
      },
    },
  };

  const tool = (): FeedbackTool => {
    const [first] = tools;

    if (first === undefined) {
      throw new Error("test setup: no tool registered");
    }

    return first;
  };

  return {
    pi,
    tools,
    notes,
    notifications,
    active: () => active,
    sessionManager,
    failAppends: (error: Error | undefined) => {
      appendError = error;
    },
    pending: () => [...pending],
    useSession: (id: string) => {
      sessionManager.newSession({ id });
    },
    registerLate: (name: string) => {
      register(name, "direct", false);
    },
    start: (reason: SessionStartEvent["reason"], restoredTools?: ReadonlyArray<string>) => {
      restore(restoredTools);

      for (const handler of sessionStartHandlers) {
        handler({ type: "session_start", reason }, { sessionManager });
      }
    },
    tree: (newLeafId: string | null, restoredTools?: ReadonlyArray<string>) => {
      const oldLeafId = sessionManager.getLeafId();

      if (newLeafId === null) {
        sessionManager.resetLeaf();
      } else {
        sessionManager.branch(newLeafId);
      }

      restore(restoredTools);

      for (const handler of sessionTreeHandlers) {
        handler({ type: "session_tree", newLeafId, oldLeafId });
      }
    },
    call: async (params: Parameters<FeedbackTool["execute"]>[1]) =>
      tool().execute("call-1", params, undefined, undefined, ctx()),
    batch: (calls: ReadonlyArray<BatchCall>) => {
      const message: MessageEndEvent["message"] = {
        role: "assistant",
        content: calls.map((call) => ({
          type: "toolCall",
          id: call.id,
          name: call.name,
          arguments: { ...call.args },
        })),
        api: "anthropic-messages",
        provider: "claude",
        model: "claude",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 0,
      };

      for (const handler of messageHandlers) {
        handler({ message });
      }
    },
    toolResult: (toolCallId: string) => {
      const message: MessageEndEvent["message"] = {
        role: "toolResult",
        toolCallId,
        toolName: "bash",
        content: [{ type: "text", text: "done" }],
        isError: false,
        timestamp: 0,
      };

      for (const handler of messageHandlers) {
        handler({ message });
      }
    },
    end: async (toolName: string, isError: boolean, text: string, toolCallId = "call-2") => {
      const event: ToolExecutionEndEvent = {
        type: "tool_execution_end",
        toolCallId,
        toolName,
        result: { content: [{ type: "text", text }] },
        isError,
      };

      for (const handler of endHandlers) {
        await handler(event, ctx());
      }
    },
    nestedStart: (
      parentToolCallId: string,
      toolCallId: string,
      toolName: string,
      args: JsonObject,
    ) => {
      const event: ToolExecutionStartEvent = {
        type: "tool_execution_start",
        toolCallId,
        toolName,
        args,
        parentToolCallId,
      };

      for (const handler of startHandlers) {
        handler(event);
      }
    },
    nestedEnd: async (
      parentToolCallId: string,
      toolCallId: string,
      toolName: string,
      isError: boolean,
      text: string,
    ) => {
      const event: ToolExecutionEndEvent = {
        type: "tool_execution_end",
        toolCallId,
        toolName,
        result: { content: [{ type: "text", text }] },
        isError,
        parentToolCallId,
      };

      for (const handler of endHandlers) {
        await handler(event, ctx());
      }
    },
    command: async (args: string) => {
      const command = commands.get("feedback");

      if (command === undefined) {
        throw new Error("test setup: no /feedback command");
      }

      await command.handler(args, commandCtx);
    },
    render: (customType: string, data: JsonValue) =>
      renderText(renderers.get(customType)?.({ data }, renderOptions, plainTheme)),
  };
}
