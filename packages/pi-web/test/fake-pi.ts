import type { RegisteredWebTool, WebToolsHandlers, WebToolsRegistration } from "../index";
import { nativeAuthFixture } from "./native-auth-fixture";

type HandlerLists = {
  session_start: WebToolsHandlers["session_start"][];
  session_shutdown: WebToolsHandlers["session_shutdown"][];
};

export async function fakePi() {
  const fixture = await nativeAuthFixture({ register: false });
  const { registry } = fixture;
  const tools: RegisteredWebTool[] = [];

  const handlers: HandlerLists = {
    session_start: [],
    session_shutdown: [],
  };

  const notifications: string[] = [];

  const api: WebToolsRegistration = {
    registerProvider: registry.registerProvider.bind(registry),
    unregisterProvider: registry.unregisterProvider.bind(registry),
    registerTool: (tool) => {
      tools.push(tool);
    },
    on: (
      ...args:
        | ["session_start", WebToolsHandlers["session_start"]]
        | ["session_shutdown", WebToolsHandlers["session_shutdown"]]
    ) => {
      if (args[0] === "session_start") {
        handlers.session_start.push(args[1]);
      } else {
        handlers.session_shutdown.push(args[1]);
      }
    },
  };

  const ctx = {
    modelRegistry: registry,
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
    },
  };

  const emit = async (event: keyof WebToolsHandlers) => {
    if (event === "session_start") {
      for (const handler of handlers.session_start) {
        handler({ type: "session_start", reason: "startup" }, ctx);
      }
    } else {
      for (const handler of handlers.session_shutdown) {
        await handler();
      }
    }
  };

  return { pi: api, tools, ctx, emit, registry, notifications, fixture };
}
