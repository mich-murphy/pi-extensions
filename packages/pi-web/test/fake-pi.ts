import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nativeAuthFixture } from "./native-auth-fixture";

export type RegisteredTool = {
  readonly name: string;
  readonly execute: (...args: readonly never[]) => Promise<unknown>;
};

type TestContext = Pick<ExtensionContext, "modelRegistry"> & {
  readonly ui: { readonly notify: (message: string) => void };
};

export async function fakePi() {
  const fixture = await nativeAuthFixture({ register: false });
  const { registry } = fixture;
  const tools: RegisteredTool[] = [];
  type Handler = (event: unknown, ctx: TestContext) => void | Promise<void>;
  const handlers = new Map<string, Handler[]>();
  const notifications: string[] = [];
  const api = {
    registerProvider: registry.registerProvider.bind(registry),
    unregisterProvider: registry.unregisterProvider.bind(registry),
    registerTool: (tool: RegisteredTool) => {
      tools.push(tool);
    },
    on: (event: string, handler: Handler) => {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
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
  const emit = async (event: string) => {
    for (const handler of handlers.get(event) ?? []) {
      await handler({}, ctx);
    }
  };
  return { pi: api, tools, ctx, emit, registry, notifications, fixture };
}
