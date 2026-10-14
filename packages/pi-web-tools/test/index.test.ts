import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WEB_AUTH_PROVIDERS } from "../authentication";
import webToolsExtension from "../index";
import { nativeAuthFixture } from "./native-auth-fixture";

type RegisteredTool = {
  readonly name: string;
  readonly execute: (...args: readonly never[]) => Promise<unknown>;
};

type TestContext = Pick<ExtensionContext, "modelRegistry"> & {
  readonly ui: { readonly notify: (message: string) => void };
};

async function fakePi() {
  const { registry } = await nativeAuthFixture({ register: false });
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
  return { pi: api, tools, ctx, emit, registry, notifications };
}

const ENV_KEYS = [
  "EXA_API_KEY",
  "PARALLEL_API_KEY",
  "BRAVE_API_KEY",
  "PI_WEB_TOOLS_PROVIDERS",
  "PI_WEB_TOOLS_EXA_ENDPOINT",
  "PI_WEB_TOOLS_PARALLEL_ENDPOINT",
  "PI_WEB_TOOLS_FETCH_RESCUE",
  "PI_WEB_TOOLS_FETCH_ALLOW_DOMAINS",
  "PI_WEB_TOOLS_FETCH_DENY_DOMAINS",
];

describe("webToolsExtension", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      vi.stubEnv(key, undefined);
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("registers tools at load and auth-only providers at session start, repeatably", async () => {
    const { pi, tools, emit, registry, notifications } = await fakePi();
    webToolsExtension(pi);
    expect(tools.map((tool) => tool.name)).toStrictEqual(["websearch", "webfetch"]);
    expect(registry.getProvider(WEB_AUTH_PROVIDERS.exa.id)).toBeUndefined();
    await emit("session_start");
    await emit("session_start");
    for (const { id } of Object.values(WEB_AUTH_PROVIDERS)) {
      expect(typeof registry.getProvider(id)?.auth.apiKey?.login).toBe("function");
      expect(registry.getModelsOfType("chat", id)).toStrictEqual([]);
      expect(registry.getModelsOfType("image", id)).toStrictEqual([]);
      expect(registry.getModelsOfType("classifier", id)).toStrictEqual([]);
    }
    expect(notifications).toStrictEqual([]);
    await emit("session_shutdown");
    expect(registry.getProvider(WEB_AUTH_PROVIDERS.exa.id)).toBeUndefined();
    await emit("session_start");
    await emit("session_shutdown");
  });

  test("invalid static configuration disables tools but leaves native login available", async () => {
    vi.stubEnv("PI_WEB_TOOLS_PROVIDERS", "exa,google");
    const { pi, tools, emit, registry, notifications } = await fakePi();
    webToolsExtension(pi);
    await expect(tools[0]?.execute()).rejects.toThrow("configuration error");
    await emit("session_start");
    expect(notifications.some((message) => message.includes("unknown provider"))).toBe(true);
    expect(typeof registry.getProvider(WEB_AUTH_PROVIDERS.exa.id)?.auth.apiKey?.login).toBe(
      "function",
    );
  });

  test("provider conflicts fail safely without replacing unrelated registrations", async () => {
    const { pi, emit, registry, notifications } = await fakePi();
    registry.registerProvider(WEB_AUTH_PROVIDERS.parallel.id, { name: "Unrelated", models: [] });
    webToolsExtension(pi);
    await emit("session_start");
    expect(registry.getProvider(WEB_AUTH_PROVIDERS.parallel.id)?.name).toBe("Unrelated");
    expect(registry.getProvider(WEB_AUTH_PROVIDERS.exa.id)).toBeUndefined();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("provider ID conflict");
    await emit("session_shutdown");
  });
});
