import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Pi double that captures lifecycle handlers and replays events with a fake context. */
export function fakePi(hasUI = true) {
  const handlers = new Map<string, Handler[]>();
  const notifications: { message: string; level: string }[] = [];
  let idle = true;
  const ctx = {
    hasUI,
    isIdle: () => idle,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
    },
  };
  const api = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  };

  return {
    pi: api as unknown as ExtensionAPI,
    emit: async (name: string): Promise<void> => {
      for (const handler of handlers.get(name) ?? []) {
        await handler({}, ctx);
      }
    },
    registeredEvents: () => [...handlers.keys()],
    notifications,
    setIdle: (value: boolean) => {
      idle = value;
    },
  };
}
