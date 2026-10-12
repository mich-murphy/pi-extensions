import type { NoSleepHandlers } from "../no-sleep-lifecycle";

type Events = { [K in keyof NoSleepHandlers]: { readonly type: K } };

/** Pi double that captures lifecycle handlers and replays events with a fake context. */
export function fakePi(hasUI = true) {
  const handlers = new Map<string, (() => void | Promise<void>)[]>();
  const events: Events = {
    agent_start: { type: "agent_start" },
    agent_settled: { type: "agent_settled" },
    session_shutdown: { type: "session_shutdown" },
  };
  const registered = new Set<keyof NoSleepHandlers>();
  const notifications: { message: string; level: string }[] = [];
  let idle = true;
  const ctx = {
    hasUI,
    isIdle: () => idle,
    ui: {
      notify: (message: string, level = "info") => notifications.push({ message, level }),
    },
  };
  const api = {
    on<K extends keyof NoSleepHandlers>(name: K, handler: NoSleepHandlers[K]) {
      handlers.set(name, [
        ...(handlers.get(name) ?? []),
        (): void | Promise<void> => handler(events[name], ctx),
      ]);
      registered.add(name);
    },
  };

  return {
    pi: api,
    emit: async (name: string): Promise<void> => {
      for (const handler of handlers.get(name) ?? []) {
        await handler();
      }
    },
    registeredEvents: () => [...registered],
    notifications,
    setIdle: (value: boolean) => {
      idle = value;
    },
  };
}
