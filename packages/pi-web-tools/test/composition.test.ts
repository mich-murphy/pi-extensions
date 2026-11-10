import { afterEach, assert, beforeEach, describe, expect, test, vi } from "vitest";
import { clearApiKeyCache } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.js";
import { WEB_AUTH_PROVIDERS } from "../authentication";
import webToolsExtension from "../index";
import { fakePi } from "./fake-pi";
import type { RegisteredTool } from "./fake-pi";
import { textOf } from "./fakes";

/**
 * The extension exactly as index.ts composes it: real settings, authentication, runtime, app
 * layer, public web client and transport. Only the outermost I/O is faked: the global fetch that
 * provider REST and MCP calls go through. Fetching a public page would need a socket, so webfetch
 * is exercised with targets the real client refuses before any connection.
 */

const KEY = "stored-exa-composition-key";

type ProviderCall = { readonly url: string; readonly apiKey: string | null };

async function runTool(tool: RegisteredTool | undefined, params: object, context: object) {
  assert(tool !== undefined);
  const result: unknown = await Reflect.apply(tool.execute, undefined, [
    "call",
    params,
    undefined,
    undefined,
    context,
  ]);
  assert(typeof result === "object" && result !== null && "content" in result);
  assert(Array.isArray(result.content));
  return textOf({ content: result.content });
}

async function composedExtension() {
  const { pi, tools, emit, ctx, fixture } = await fakePi();
  webToolsExtension(pi);
  await emit("session_start");
  const named = (name: string) => tools.find((tool) => tool.name === name);
  const login = async (key: string) =>
    fixture.runtime.login(WEB_AUTH_PROVIDERS.exa.id, "api_key", {
      prompt: async () => key,
      notify: () => {
        /* isolated synthetic login */
      },
    });
  return {
    webfetch: named("webfetch"),
    websearch: named("websearch"),
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
    vi.stubGlobal("fetch", async (input: unknown, init?: { headers?: HeadersInit }) => {
      providerCalls.push({
        url: String(input),
        apiKey: new Headers(init?.headers).get("x-api-key"),
      });
      return new Response(
        JSON.stringify({
          results: [{ title: "Composed result", url: "https://example.com/a", text: "body" }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
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
      // A missing transport layer would instead fail with "Web fetch failed unexpectedly".
      const { webfetch, emit, context } = await composedExtension();
      await expect(runTool(webfetch, { url }, context)).rejects.toThrow(message);
      expect(providerCalls).toStrictEqual([]);
      await emit("session_shutdown");
    },
  );

  test("the composed credential resolver hands Pi's stored key to the provider request", async () => {
    const { websearch, emit, context, login } = await composedExtension();
    await login(KEY);
    const text = await runTool(websearch, { query: "composition", provider: "exa" }, context);
    expect(text).toContain("Composed result");
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]?.apiKey).toBe(KEY);
    expect(providerCalls[0]?.url).toBe("https://api.exa.ai/search");
    expect(text).not.toContain(KEY);
    await emit("session_shutdown");
  });
});
