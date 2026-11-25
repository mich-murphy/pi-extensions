import type { ToolExecutionEndEvent } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type {
  FeedbackCommandContext,
  FeedbackContext,
  FeedbackNote,
  FeedbackRegistration,
  FeedbackTool,
  NoteRenderer,
} from "../feedback.ts";

type Command = Parameters<FeedbackRegistration["registerCommand"]>[1];
type EndHandler = (event: ToolExecutionEndEvent, ctx: FeedbackContext) => Promise<void>;

const plainTheme = { fg: (_color: string, text: string) => text };

function renderText(component: Component | undefined): string {
  return (component?.render(200) ?? [])
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

export function fakePi(packagesDir: string) {
  const tools: FeedbackTool[] = [];
  const renderers = new Map<string, NoteRenderer>();
  const commands = new Map<string, Command>();
  const endHandlers: EndHandler[] = [];
  const notes: { customType: string; data: FeedbackNote }[] = [];
  const notifications: { message: string; level: string | undefined }[] = [];
  let active = ["read", "bash"];
  let session = "session-a";

  const registered = [
    { name: "read", sourceInfo: { path: "builtin:read" } },
    { name: "bash", sourceInfo: { path: "builtin:bash" } },
    { name: "webfetch", sourceInfo: { path: `${packagesDir}/pi-web/index.ts` } },
    { name: "outside", sourceInfo: { path: "/elsewhere/pi-web/index.ts" } },
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
    on: (_name, handler) => {
      endHandlers.push(handler);
    },
    appendEntry: (customType, data) => {
      notes.push({ customType, data });
    },
    getAllTools: () => [
      ...registered,
      ...tools.map((tool) => ({
        name: tool.name,
        sourceInfo: { path: `${packagesDir}/pi-feedback/index.ts` },
      })),
    ],
    getActiveTools: () => [...active],
    setActiveTools: (names) => {
      active = [...names];
    },
  };

  const ctx = (): FeedbackContext => ({
    sessionManager: { getSessionId: () => session },
    model: { provider: "claude", id: "claude-opus-5-5" },
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
    end: async (toolName: string, isError: boolean, text: string) => {
      const event: ToolExecutionEndEvent = {
        type: "tool_execution_end",
        toolCallId: "call-2",
        toolName,
        result: { content: [{ type: "text", text }] },
        isError,
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
    render: (customType: string, data: unknown) =>
      renderText(renderers.get(customType)?.({ data }, {}, plainTheme)),
  };
}
