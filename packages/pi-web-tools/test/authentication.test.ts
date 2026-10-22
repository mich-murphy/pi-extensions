import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted, Result } from "effect";
import { afterEach, assert, describe, expect, test, vi } from "vitest";
import { clearApiKeyCache } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.js";
import { createWebAuthentication, WEB_AUTH_PROVIDERS } from "../authentication";
import type { SearchProviderName } from "../types";
import { inheritingChild, nativeAuthFixture } from "./native-auth-fixture";

async function fixture(key?: string) {
  const {
    storage,
    runtime,
    registry,
    authentication: controller,
    pi,
  } = await nativeAuthFixture({
    initial: key === undefined ? {} : { "pi-web-tools-exa": { type: "api_key", key } },
  });
  const resolve = async () =>
    Effect.runPromise(Effect.result(controller.resolverFor(registry).resolve("exa")));
  return { storage, runtime, registry, controller, pi, resolve };
}

describe("public native web authentication", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    clearApiKeyCache();
  });
  test("environment fallback, stored precedence, rotation and logout without models", async () => {
    vi.stubEnv("EXA_API_KEY", " \n\t ambient-synthetic \n\t ");
    const { registry, runtime, resolve } = await fixture(" \n\t stored-synthetic \n\t ");
    for (const metadata of Object.values(WEB_AUTH_PROVIDERS)) {
      expect(registry.getAll().filter((model) => model.provider === metadata.id)).toStrictEqual([]);
      expect(registry.getProvider(metadata.id)?.name).toBe(metadata.label);
      expect(typeof registry.getProvider(metadata.id)?.auth.apiKey?.login).toBe("function");
    }
    const first = await resolve();
    assert(Result.isSuccess(first));
    assert(first.success !== undefined);
    expect(Redacted.value(first.success)).toBe("stored-synthetic");
    await runtime.login("pi-web-tools-exa", "api_key", {
      prompt: async () => "rotated-synthetic",
      notify: () => {
        /* no UI in isolated runtime */
      },
    });
    const rotated = await resolve();
    assert(Result.isSuccess(rotated));
    assert(rotated.success !== undefined);
    expect(Redacted.value(rotated.success)).toBe("rotated-synthetic");
    await runtime.logout("pi-web-tools-exa");
    const ambient = await resolve();
    assert(Result.isSuccess(ambient));
    assert(ambient.success !== undefined);
    expect(Redacted.value(ambient.success)).toBe("ambient-synthetic");
  });

  test.each(["", " ", "$PI_WEB_TEST_UNRESOLVED", "!printf ''", "!exit 7", "bad\nkey"])(
    "stored unusable key fails rather than falling back: %j",
    async (key) => {
      vi.stubEnv("EXA_API_KEY", "ambient-synthetic");
      vi.stubEnv("PI_WEB_TEST_UNRESOLVED", "");
      const { resolve } = await fixture(key);
      const result = await resolve();
      assert(Result.isFailure(result));
      expect(["invalid", "incompatible", "resolution"]).toContain(result.failure.reason);
      expect(JSON.stringify(result)).not.toContain("ambient-synthetic");
      expect(JSON.stringify(result)).not.toContain("printf");
    },
  );

  test("command success and command cache remain Pi-owned", async () => {
    vi.stubEnv("PI_WEB_COMMAND_TEST", "first-synthetic");
    const { resolve } = await fixture('!printf %s "$PI_WEB_COMMAND_TEST"');
    const first = await resolve();
    assert(Result.isSuccess(first));
    assert(first.success !== undefined);
    expect(Redacted.value(first.success)).toBe("first-synthetic");
    vi.stubEnv("PI_WEB_COMMAND_TEST", "second-synthetic");
    const cached = await resolve();
    assert(Result.isSuccess(cached));
    assert(cached.success !== undefined);
    expect(Redacted.value(cached.success)).toBe("first-synthetic");
    clearApiKeyCache();
    const updated = await resolve();
    assert(Result.isSuccess(updated));
    assert(updated.success !== undefined);
    expect(Redacted.value(updated.success)).toBe("second-synthetic");
  });

  test("absent and blank ambient keys are absent, check does not use resolve", async () => {
    vi.stubEnv("EXA_API_KEY", " ");
    const { registry, runtime, resolve } = await fixture();
    await expect(resolve()).resolves.toStrictEqual(Result.succeed(undefined));
    await expect(runtime.checkAuth("pi-web-tools-exa")).resolves.toBeUndefined();
    const auth = registry.getRegisteredNativeProvider("pi-web-tools-exa")?.auth.apiKey;
    assert(auth !== undefined);
    assert(typeof auth.check === "function");
    await expect(
      auth.check({
        credential: { type: "api_key", key: "!must-not-execute" },
        ctx: {
          env: async () => {
            throw new Error("must not read env");
          },
          fileExists: async () => false,
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toStrictEqual({ type: "api_key", source: "stored credential" });
  });

  test("preflights all collisions, detects replacement, allows owned repeated registration", async () => {
    const { registry, controller, pi, resolve } = await fixture("synthetic");
    controller.register(pi, registry);
    const stranger = createWebAuthentication();
    const register = vi.spyOn(pi, "registerProvider");
    expect(() => {
      stranger.register(pi, registry);
    }).toThrow("collision");
    expect(register).not.toHaveBeenCalled();
    const native = registry.getRegisteredNativeProvider("pi-web-tools-exa");
    assert(native);
    registry.registerProvider({ ...native });
    const result = await resolve();
    assert(Result.isFailure(result));
    expect(result.failure.reason).toBe("incompatible");
    expect(() => {
      controller.register(pi, registry);
    }).toThrow("collision");
  });

  test("removed native registration and interrupted partial registration cannot silently recover", async () => {
    const active = await nativeAuthFixture();
    active.registry.unregisterProvider("pi-web-tools-parallel");
    expect(() => {
      active.authentication.register(active.pi, active.registry);
    }).toThrow("collision");
    const partial = await nativeAuthFixture({ register: false });
    const register = vi.spyOn(partial.pi, "registerProvider").mockImplementationOnce(() => {
      throw new Error("synthetic registration failure");
    });
    expect(() => {
      partial.authentication.register(partial.pi, partial.registry);
    }).toThrow("synthetic registration failure");
    register.mockRestore();
    expect(() => {
      partial.authentication.register(partial.pi, partial.registry);
    }).toThrow("collision");
    const outcome = await Effect.runPromise(
      Effect.result(partial.authentication.resolverFor(partial.registry).resolve("exa")),
    );
    assert(Result.isFailure(outcome));
    expect(outcome.failure.reason).toBe("incompatible");
  });

  test.each(["check", "resolve"] as const)(
    "native %s honors cancellation after ambient lookup",
    async (method) => {
      const { registry } = await nativeAuthFixture();
      const auth = registry.getRegisteredNativeProvider("pi-web-tools-exa")?.auth.apiKey;
      assert(auth !== undefined);
      const operation = auth[method];
      assert(typeof operation === "function");
      const controller = new AbortController();
      await expect(
        operation({
          ctx: {
            env: async () => {
              controller.abort();
              return "late-synthetic-key";
            },
            fileExists: async () => false,
          },
          signal: controller.signal,
        }),
      ).rejects.toThrow("aborted");
    },
  );

  test("shutdown unregisters owned providers without removing credentials; reload can register again", async () => {
    const current = await fixture("persisted-synthetic-key");
    const cleanup = {
      unregisterProvider: current.registry.unregisterProvider.bind(current.registry),
    };
    current.controller.unregister(cleanup, current.registry);
    current.controller.unregister(cleanup, current.registry);
    for (const metadata of Object.values(WEB_AUTH_PROVIDERS)) {
      expect(current.registry.getProvider(metadata.id)).toBeUndefined();
    }
    await expect(current.storage.read("pi-web-tools-exa")).resolves.toStrictEqual({
      type: "api_key",
      key: "persisted-synthetic-key",
    });
    const reloaded = createWebAuthentication();
    reloaded.register(current.pi, current.registry);
    const outcome = await Effect.runPromise(reloaded.resolverFor(current.registry).resolve("exa"));
    assert(outcome !== undefined);
    expect(Redacted.value(outcome)).toBe("persisted-synthetic-key");
  });

  test("shutdown leaves replacement providers intact", async () => {
    const { registry, controller } = await fixture();
    const original = registry.getRegisteredNativeProvider("pi-web-tools-exa");
    assert(original !== undefined);
    const replacement = { ...original, name: "Unrelated replacement" };
    registry.registerProvider(replacement);
    const cleanup = { unregisterProvider: registry.unregisterProvider.bind(registry) };
    controller.unregister(cleanup, registry);
    expect(registry.getRegisteredNativeProvider("pi-web-tools-exa")).toBe(replacement);
    expect(registry.getProvider("pi-web-tools-parallel")).toBeUndefined();
    controller.unregister(cleanup, registry);
    expect(registry.getRegisteredNativeProvider("pi-web-tools-exa")).toBe(replacement);
  });

  test("external unsupported OAuth credentials fail even with a stale availability snapshot", async () => {
    vi.stubEnv("EXA_API_KEY", "");
    const { storage, resolve, registry } = await fixture();
    await expect(resolve()).resolves.toStrictEqual(Result.succeed(undefined));
    const status = registry.getProviderAuthStatus("pi-web-tools-exa");
    await storage.modify("pi-web-tools-exa", async () => ({
      type: "oauth",
      access: "external-synthetic-access",
      refresh: "external-synthetic-refresh",
      expires: Date.now() + 600_000,
    }));
    expect(registry.getProviderAuthStatus("pi-web-tools-exa")).toStrictEqual(status);
    const result = await resolve();
    assert(Result.isFailure(result));
    expect(result.failure.reason).toBe("incompatible");
    expect(JSON.stringify(result)).not.toContain("external-synthetic");
  });

  test("composed models.json overrides preserve stored precedence and fail safely on invalid headers", async () => {
    vi.stubEnv("EXA_API_KEY", "ambient-synthetic");
    vi.stubEnv("PI_WEB_MISSING_HEADER", "");
    const directory = await mkdtemp(join(tmpdir(), "pi-web-auth-models-"));
    const modelsPath = join(directory, "models.json");
    const config = {
      providers: {
        "pi-web-tools-exa": {
          apiKey: "configured-synthetic",
          baseUrl: "https://untrusted.example",
          headers: { "X-Test": "synthetic-header" },
        },
      },
    };
    try {
      await writeFile(modelsPath, JSON.stringify({ providers: {} }));
      const { storage, registry, authentication } = await nativeAuthFixture({ modelsPath });
      await writeFile(modelsPath, JSON.stringify(config));
      await registry.refresh({ allowNetwork: false });
      const resolve = async () =>
        Effect.runPromise(Effect.result(authentication.resolverFor(registry).resolve("exa")));
      const configured = await resolve();
      assert(Result.isSuccess(configured));
      assert(configured.success !== undefined);
      expect(Redacted.value(configured.success)).toBe("configured-synthetic");
      await storage.modify("pi-web-tools-exa", async () => ({
        type: "api_key",
        key: "stored-synthetic",
      }));
      const stored = await resolve();
      assert(Result.isSuccess(stored));
      assert(stored.success !== undefined);
      expect(Redacted.value(stored.success)).toBe("stored-synthetic");
      config.providers["pi-web-tools-exa"].headers["X-Test"] = "$PI_WEB_MISSING_HEADER";
      await writeFile(modelsPath, JSON.stringify(config));
      await registry.refresh({ allowNetwork: false });
      const rejected = await resolve();
      assert(Result.isFailure(rejected));
      expect(rejected.failure.reason).toBe("resolution");
      expect(JSON.stringify(rejected)).not.toContain("PI_WEB_MISSING_HEADER");
      expect(JSON.stringify(rejected)).not.toContain("stored-synthetic");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("subagent child registry resolves credentials after inheriting the parent's providers", async () => {
    vi.stubEnv("EXA_API_KEY", "");
    vi.stubEnv("PARALLEL_API_KEY", "");
    vi.stubEnv("BRAVE_API_KEY", "ambient-synthetic");
    const parent = await nativeAuthFixture({
      initial: { "pi-web-tools-exa": { type: "api_key", key: "stored-synthetic" } },
    });
    const child = await inheritingChild(parent);
    child.authentication.register(child.pi, child.registry);
    const resolve = async (owner: typeof parent, provider: SearchProviderName) =>
      Effect.runPromise(
        Effect.result(owner.authentication.resolverFor(owner.registry).resolve(provider)),
      );
    for (const owner of [child, parent]) {
      const stored = await resolve(owner, "exa");
      assert(Result.isSuccess(stored));
      assert(stored.success !== undefined);
      expect(Redacted.value(stored.success)).toBe("stored-synthetic");
      const ambient = await resolve(owner, "brave");
      assert(Result.isSuccess(ambient));
      assert(ambient.success !== undefined);
      expect(Redacted.value(ambient.success)).toBe("ambient-synthetic");
      await expect(resolve(owner, "parallel")).resolves.toStrictEqual(Result.succeed(undefined));
    }
    child.authentication.unregister(
      { unregisterProvider: child.registry.unregisterProvider.bind(child.registry) },
      child.registry,
    );
    for (const metadata of Object.values(WEB_AUTH_PROVIDERS)) {
      expect(child.registry.getProvider(metadata.id)).toBeUndefined();
      expect(parent.registry.getRegisteredNativeProvider(metadata.id)?.name).toBe(metadata.label);
    }
    const afterChild = await resolve(parent, "exa");
    assert(Result.isSuccess(afterChild));
    assert(afterChild.success !== undefined);
    expect(Redacted.value(afterChild.success)).toBe("stored-synthetic");
  });

  test("subagent child still rejects a foreign provider with a web tools ID", async () => {
    const parent = await nativeAuthFixture();
    const native = parent.registry.getRegisteredNativeProvider("pi-web-tools-parallel");
    assert(native !== undefined);
    parent.registry.registerProvider({ ...native, name: "Foreign" });
    const child = await inheritingChild(parent);
    const register = vi.spyOn(child.pi, "registerProvider");
    expect(() => {
      child.authentication.register(child.pi, child.registry);
    }).toThrow("collision");
    expect(register).not.toHaveBeenCalled();
    const outcome = await Effect.runPromise(
      Effect.result(child.authentication.resolverFor(child.registry).resolve("exa")),
    );
    assert(Result.isFailure(outcome));
    expect(outcome.failure.reason).toBe("incompatible");
  });

  test("Pi command timeout fails safely", async () => {
    const { resolve } = await fixture("!printf timeout-secret; exec sleep 11");
    const result = await resolve();
    assert(Result.isFailure(result));
    expect(JSON.stringify(result)).not.toContain("timeout-secret");
    expect(JSON.stringify(result)).not.toContain("sleep");
  }, 30_000);
});
