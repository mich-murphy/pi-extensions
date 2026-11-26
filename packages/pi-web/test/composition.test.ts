import { afterEach, assert, beforeEach, describe, expect, test, vi } from "vitest";
import { clearApiKeyCache } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.js";
import { WEB_AUTH_PROVIDERS } from "../authentication";
import webExtension from "../index";
import type { HttpFetch } from "../network";
import { fakePi } from "./fake-pi";
import { textOf } from "./fakes";

const KEY = "stored-exa-composition-key";

type ProviderCall = { readonly url: string; readonly apiKey: string | null };

async function composedExtension() {
  const { pi, tools, emit, ctx, fixture } = await fakePi();
  webExtension(pi);
  await emit("session_start");

  const login = async (key: string) =>
    fixture.runtime.login(WEB_AUTH_PROVIDERS.exa.id, "api_key", {
      prompt: async () => key,
      notify: () => undefined,
    });

  return {
    webfetch: tools.find((tool) => tool.name === "webfetch"),
    websearch: tools.find((tool) => tool.name === "websearch"),
    emit,
    context: { modelRegistry: ctx.modelRegistry },
    login,
  };
}

describe("the composed extension", () => {
  const providerCalls: ProviderCall[] = [];

  beforeEach(() => {
    for (const variable of ["EXA_API_KEY", "PARALLEL_API_KEY", "BRAVE_API_KEY"]) {
      vi.stubEnv(variable, "");
    }

    clearApiKeyCache();
    providerCalls.length = 0;

    const fetchProvider: HttpFetch["Service"]["fetch"] = async (input, init) => {
      providerCalls.push({
        url: input.toString(),
        apiKey: new Headers(init.headers).get("x-api-key"),
      });

      return new Response(
        JSON.stringify({
          results: [{ title: "Composed result", url: "https://example.com/a", text: "body" }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    };

    vi.stubGlobal("fetch", fetchProvider);
  });
  afterEach(() => {
    clearApiKeyCache();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test.each([
    ["a loopback literal", "http://127.0.0.1:8080/", "Blocked private or local IP address"],
    ["an IPv6 loopback literal", "http://[::1]/", "Blocked private or local IP address"],
    ["a decimal-encoded loopback", "http://2130706433/", "Blocked private or local IP address"],
    ["the localhost name", "http://localhost/", "Blocked private or local host"],
  ])(
    "webfetch refuses %s through the real client and transport layers",
    async (_name, url, message) => {
      const { webfetch, emit, context } = await composedExtension();
      assert(webfetch !== undefined);
      await expect(
        webfetch.execute("call", { url }, undefined, undefined, context),
      ).rejects.toThrow(message);
      expect(providerCalls).toStrictEqual([]);
      await emit("session_shutdown");
    },
  );

  test("the composed credential resolver hands Pi's stored key to the provider request", async () => {
    const { websearch, emit, context, login } = await composedExtension();
    await login(KEY);
    assert(websearch !== undefined);

    const text = textOf(
      await websearch.execute(
        "call",
        { query: "composition", provider: "exa" },
        undefined,
        undefined,
        context,
      ),
    );

    expect(text).toContain("Composed result");
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]?.apiKey).toBe(KEY);
    expect(providerCalls[0]?.url).toBe("https://api.exa.ai/search");
    expect(text).not.toContain(KEY);
    await emit("session_shutdown");
  });
});
