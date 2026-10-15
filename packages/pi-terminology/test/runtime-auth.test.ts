import type { ClassifierApi, ClassifierContext, ClassifierModel } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, assert, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { clearApiKeyCache } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.js";

function authorizationHeader(init: RequestInit | undefined): string {
  return new Headers(init?.headers).get("authorization") ?? "";
}

const context: ClassifierContext = {
  state: { prompt: "Change production code to see whether tests fail." },
  questions: {
    "core:mutation-testing": {
      type: "bool",
      instructions: "Does the prompt ask for mutation testing?",
      criteria: { true: "mutate production code", false: "ordinary implementation" },
    },
  },
};

async function nativeRegistry(): Promise<{
  readonly runtime: ModelRuntime;
  readonly registry: ModelRegistry;
  readonly model: ClassifierModel<ClassifierApi>;
}> {
  const runtime = await ModelRuntime.create({
    credentials: AuthStorage.inMemory({}),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  const model = registry.findOfType("classifier", "typesafe", "jev-latest");
  assert(model !== undefined);
  return { runtime, registry, model };
}

describe("terminology native TypeSafe authentication", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    clearApiKeyCache();
  });

  test("resolves TYPESAFE_API_KEY through Pi runtime without exposing it in results", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "synthetic-env-key");
    const { registry, model } = await nativeRegistry();
    let authorization = "";
    const result = await registry.classify(model, context, {
      timeoutMs: 5000,
      maxRetries: 0,
      fetch: async (_url, init) => {
        authorization = authorizationHeader(init);
        return Response.json({
          answers: { "core:mutation-testing": { type: "noul", noul: 0.97 } },
          usage: { input_tokens: 7, output_tokens: 1 },
        });
      },
    });
    expect(authorization).toBe("Bearer synthetic-env-key");
    expect(result.answers["core:mutation-testing"]).toStrictEqual({
      type: "bool",
      probability: 0.97,
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-env-key");
  });

  test("uses stored credentials and cached secret commands through Pi runtime", async () => {
    vi.stubEnv("TERMS_SECRET", "first-secret");
    const { runtime, registry, model } = await nativeRegistry();
    await runtime.login("typesafe", "api_key", {
      prompt: async () => "!printf %s $TERMS_SECRET",
      notify: () => undefined,
    });
    const keys: string[] = [];
    const fetch = async (_url: URL | RequestInfo, init?: RequestInit) => {
      keys.push(authorizationHeader(init));
      return Response.json({ answers: { "core:mutation-testing": { type: "noul", noul: 0.2 } } });
    };
    await registry.classify(model, context, { timeoutMs: 5000, maxRetries: 0, fetch });
    vi.stubEnv("TERMS_SECRET", "second-secret");
    await registry.classify(model, context, { timeoutMs: 5000, maxRetries: 0, fetch });
    expect(keys).toStrictEqual(["Bearer first-secret", "Bearer first-secret"]);
  });

  test("returns sanitized auth errors without HTTP when auth is missing", async () => {
    const { registry, model } = await nativeRegistry();
    let called = false;
    const result = await registry.classify(model, context, {
      timeoutMs: 5000,
      maxRetries: 0,
      fetch: async () => {
        called = true;
        return Response.json({});
      },
    });
    expect(called).toBe(false);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Provider is not configured");
    expect(result.errorMessage).not.toContain("TYPESAFE_API_KEY");
  });
});
