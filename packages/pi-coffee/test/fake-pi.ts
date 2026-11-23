import type { CoffeeHandlers, CoffeeRegistration } from "../coffee-lifecycle";

type Events = { [K in keyof CoffeeHandlers]: { readonly type: K } };
type Command = Parameters<CoffeeRegistration["registerCommand"]>[1];

export function fakePi(hasUI = true) {
  const handlers = new Map<string, (() => void | Promise<void>)[]>();
  const events: Events = {
    agent_start: { type: "agent_start" },
    agent_settled: { type: "agent_settled" },
    session_shutdown: { type: "session_shutdown" },
  };
  const registered = new Set<keyof CoffeeHandlers>();
  const commands = new Map<string, Command>();
  const notifications: { message: string; level: string }[] = [];
  let idle = true;
  const ctx = {
    hasUI,
    isIdle: () => idle,
    ui: {
      notify: (message: string, level = "info") => notifications.push({ message, level }),
    },
  };
  const api: CoffeeRegistration = {
    registerCommand: (name, options) => {
      commands.set(name, options);
    },
    on<K extends keyof CoffeeHandlers>(name: K, handler: CoffeeHandlers[K]) {
      handlers.set(name, [
        ...(handlers.get(name) ?? []),
        (): void | Promise<void> => handler(events[name], ctx),
      ]);
      registered.add(name);
    },
  };

  const coffeeCommand = (): Command => {
    const command = commands.get("coffee");
    if (command === undefined) {
      throw new Error("test setup: no coffee command registered");
    }
    return command;
  };

  return {
    pi: api,
    emit: async (name: string): Promise<void> => {
      for (const handler of handlers.get(name) ?? []) {
        await handler();
      }
    },
    command: async (args: string): Promise<void> => coffeeCommand().handler(args, ctx),
    completions: async (prefix: string) => coffeeCommand().getArgumentCompletions?.(prefix),
    registeredEvents: () => [...registered],
    registeredCommands: () => [...commands.keys()],
    notifications,
    setIdle: (value: boolean) => {
      idle = value;
    },
  };
}
