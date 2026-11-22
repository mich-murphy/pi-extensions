import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WEB_AUTH_PROVIDERS } from "../authentication";
import webExtension from "../index";
import { fakePi } from "./fake-pi";

const ENV_KEYS = [
  "EXA_API_KEY",
  "PARALLEL_API_KEY",
  "BRAVE_API_KEY",
  "PI_WEB_PROVIDERS",
  "PI_WEB_EXA_ENDPOINT",
  "PI_WEB_PARALLEL_ENDPOINT",
  "PI_WEB_FETCH_RESCUE",
  "PI_WEB_FETCH_ALLOW_DOMAINS",
  "PI_WEB_FETCH_DENY_DOMAINS",
];

describe("webExtension", () => {
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
    webExtension(pi);
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
    vi.stubEnv("PI_WEB_PROVIDERS", "exa,google");
    const { pi, tools, emit, registry, notifications } = await fakePi();
    webExtension(pi);
    await expect(tools[0]?.execute()).rejects.toThrow("is not configured");
    await emit("session_start");
    expect(notifications.some((message) => message.includes("unknown provider"))).toBe(true);
    expect(typeof registry.getProvider(WEB_AUTH_PROVIDERS.exa.id)?.auth.apiKey?.login).toBe(
      "function",
    );
  });

  test("provider conflicts fail safely without replacing unrelated registrations", async () => {
    const { pi, emit, registry, notifications } = await fakePi();
    registry.registerProvider(WEB_AUTH_PROVIDERS.parallel.id, { name: "Unrelated", models: [] });
    webExtension(pi);
    await emit("session_start");
    expect(registry.getProvider(WEB_AUTH_PROVIDERS.parallel.id)?.name).toBe("Unrelated");
    expect(registry.getProvider(WEB_AUTH_PROVIDERS.exa.id)).toBeUndefined();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("Remove a duplicate pi-web");
    await emit("session_shutdown");
  });
});
