import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import type {
  MessageEndEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { BatchCall } from "../batch.ts";
import type { ClassifierRegistry } from "../classify.ts";
import type {
  FeedbackCommandContext,
  FeedbackContext,
  FeedbackNote,
  FeedbackRegistration,
  FeedbackTool,
  NoteRenderer,
} from "../feedback.ts";
import { noClassifier } from "./fake-classifier.ts";

type Command = Parameters<FeedbackRegistration["registerCommand"]>[1];

type StartHandler = (event: ToolExecutionStartEvent) => void;

type Handler = EndHandler | MessageHandler | StartHandler;

type EndHandler = (event: ToolExecutionEndEvent, ctx: FeedbackContext) => Promise<void>;

type MessageHandler = (event: Pick<MessageEndEvent, "message">) => void;

function isEndHandler(name: string, _handler: Handler): _handler is EndHandler {
  return name === "tool_execution_end";
}

function isStartHandler(name: string, _handler: Handler): _handler is StartHandler {
  return name === "tool_execution_start";
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
  modelRegistry: ClassifierRegistry = noClassifier,
) {
  const tools: Array<FeedbackTool> = [];
  const renderers = new Map<string, NoteRenderer>();
  const commands = new Map<string, Command>();
  const endHandlers: Array<EndHandler> = [];
  const messageHandlers: Array<MessageHandler> = [];
  const startHandlers: Array<StartHandler> = [];
  const notes: Array<{ customType: string; data: FeedbackNote }> = [];
  const notifications: Array<{ message: string; level: string | undefined }> = [];
  let active = ["read", "bash"];
  let session = "session-a";

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
      tools.push(tool);
      active = [...active, tool.name];
    },
    registerEntryRenderer: (customType, renderer) => {
      renderers.set(customType, renderer);
    },
    registerCommand: (name, options) => {
      commands.set(name, options);
    },
    on: (name: string, handler: Handler) => {
      if (isEndHandler(name, handler)) {
        endHandlers.push(handler);
      } else if (isStartHandler(name, handler)) {
        startHandlers.push(handler);
      } else {
        messageHandlers.push(handler);
      }
    },
    appendEntry: (customType, data) => {
      notes.push({ customType, data });
    },
    getAllTools: () => [
      ...registered,
      ...tools.map((tool) => ({
        name: tool.name,
        sourceInfo: { path: `${packagesDir}/pi-feedback/index.ts`, source: "local" },
      })),
    ],
    getCommands: () => slashCommands,
    getActiveTools: () => [...active],
    setActiveTools: (names) => {
      active = [...names];
    },
  };

  const ctx = (): FeedbackContext => ({
    sessionManager: { getSessionId: () => session },
    model: { provider: "claude", id: "claude-opus-5-5" },
    modelRegistry,
  });

  const commandCtx: FeedbackCommandContext = {
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
    useSession: (id: string) => {
      session = id;
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
