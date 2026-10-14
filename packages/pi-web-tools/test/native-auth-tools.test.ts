import { readFile, rm } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { afterEach, assert, beforeEach, describe, expect, test, vi } from "vitest";
import { clearApiKeyCache } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.js";
import { WEB_AUTH_PROVIDERS } from "../authentication";
import { CredentialResolver } from "../credentials";
import { FetchPage } from "../fetch-page";
import { McpClients } from "../mcp";
import type { McpToolCallResult } from "../mcp";
import { ProviderHttpClient } from "../provider-http";
import type { ProviderHttpRequest, ProviderHttpResponse } from "../provider-http";
import { ProviderProtocolInvalid } from "../provider-types";
import type { ProviderError } from "../provider-types";
import { FetchRescueProviders, SearchProviders } from "../search";
import { WebToolsConfig } from "../settings";
import { ToolOutputStore } from "../tool-output";
import { createToolRuntime } from "../tool-runtime";
import { createWebFetchTool } from "../webfetch";
import { createWebSearchTool } from "../websearch";
import { settingsFrom, textOf } from "./fakes";
import { nativeAuthFixture } from "./native-auth-fixture";
import type { AuthStorageData } from "./native-auth-fixture";

const cleanup: (() => Promise<void>)[] = [];
const pageUrl = "https://example.com/page";
const searchPayload = (text: string) => ({
  results: [{ title: text, url: pageUrl, text, excerpts: [text] }],
  web: { results: [{ title: text, url: pageUrl, description: text }] },
});

/** Only production I/O ports are replaced; routing, auth, projection and runtime are live. */
async function tools(
  options: {
    initial?: AuthStorageData;
    settings?: Record<string, string>;
    http?: (request: ProviderHttpRequest) => Effect.Effect<ProviderHttpResponse, ProviderError>;
    mcp?: (
      name: string,
      args: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<McpToolCallResult, ProviderError>;
  } = {},
) {
  const native = await nativeAuthFixture(options.initial ? { initial: options.initial } : {});
  const settings = settingsFrom(options.settings);
  const requests: ProviderHttpRequest[] = [];
  const calls: {
    endpoint: string;
    name: string;
    args: Readonly<Record<string, unknown>>;
    secrets: readonly string[];
  }[] = [];
  const respond = (request: ProviderHttpRequest) =>
    Effect.suspend(() => {
      requests.push(request);
      return (
        options.http?.(request) ??
        Effect.succeed({ bodyText: JSON.stringify(searchPayload("answer")) })
      );
    });
  const ports = Layer.mergeAll(
    WebToolsConfig.layer(settings),
    Layer.succeed(
      ProviderHttpClient,
      ProviderHttpClient.of({ postJson: respond, getJson: respond }),
    ),
    Layer.succeed(
      McpClients,
      McpClients.of({
        forEndpoint: (endpoint) => ({
          callTool: (name, args, secrets = []) =>
            Effect.suspend(() => {
              calls.push({ endpoint, name, args, secrets });
              return (
                options.mcp?.(name, args) ??
                Effect.succeed({
                  text:
                    name === "web_search_exa"
                      ? ["Title: answer\nURL: https://example.com/page\nText: answer"]
                      : ["rescued page"],
                  structuredContent:
                    name === "web_fetch"
                      ? { results: [{ url: pageUrl, content: "rescued page" }] }
                      : searchPayload("answer"),
                })
              );
            }),
        }),
      }),
    ),
  );
  const runtime = createToolRuntime(
    Layer.mergeAll(
      Layer.mergeAll(SearchProviders.layer, FetchRescueProviders.layer).pipe(Layer.provide(ports)),
      WebToolsConfig.layer(settings),
      CredentialResolver.unavailableLayer,
      ToolOutputStore.layer,
      Layer.succeed(
        FetchPage,
        FetchPage.of({
          fetch: ({ url, format }) =>
            Effect.succeed({
              meta: {
                requestedUrl: url,
                finalUrl: url,
                format,
                status: 200,
                mime: "text/html",
                contentType: "text/html",
                bytes: 0,
              },
              body: { _tag: "Text", kind: "html", text: "", decoder: "utf-8" },
            }),
        }),
      ),
    ),
  );
  cleanup.push(async () => runtime.dispose());
  const composition = {
    settings,
    runtime,
    redactText: (text: string) => text,
    credentialsForContext: (ctx: { modelRegistry: typeof native.registry }) =>
      native.authentication.resolverFor(ctx.modelRegistry),
  };
  const search = createWebSearchTool(composition);
  const fetch = createWebFetchTool(composition);
  const context = { modelRegistry: native.registry };
  const login = async (provider: keyof typeof WEB_AUTH_PROVIDERS, key: string) =>
    native.runtime.login(WEB_AUTH_PROVIDERS[provider].id, "api_key", {
      prompt: async () => key,
      notify: () => {
        /* isolated synthetic login */
      },
    });
  const logout = async (provider: keyof typeof WEB_AUTH_PROVIDERS) =>
    native.runtime.logout(WEB_AUTH_PROVIDERS[provider].id);
  const runSearch = async (provider?: "exa" | "parallel" | "brave") =>
    search.execute(
      "search",
      { query: "query", ...(provider ? { provider } : {}) },
      undefined,
      undefined,
      context,
    );
  const runFetch = async () =>
    fetch.execute("fetch", { url: pageUrl }, undefined, undefined, context);
  return {
    ...native,
    runtime,
    login,
    logout,
    search,
    fetch,
    context,
    requests,
    calls,
    runSearch,
    runFetch,
  };
}

function deferred<A>() {
  return Promise.withResolvers<A>();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected failure";
}

describe("native-auth integration", () => {
  beforeEach(() => {
    for (const variable of ["EXA_API_KEY", "PARALLEL_API_KEY", "BRAVE_API_KEY"]) {
      vi.stubEnv(variable, "");
    }
    clearApiKeyCache();
  });
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map(async (dispose) => dispose()));
    clearApiKeyCache();
    vi.unstubAllEnvs();
  });

  describe("native authentication through actual web tools", () => {
    test("stored Brave joins the default chain; absent explicit Brave is a safe failure", async () => {
      const absent = await tools({ settings: { PI_WEB_TOOLS_PROVIDERS: "brave" } });
      await expect(absent.runSearch("brave")).rejects.toThrow("credential unavailable");
      expect(absent.requests).toHaveLength(0);
      const t = await tools({
        initial: { "pi-web-tools-brave": { type: "api_key", key: "stored-brave" } },
        mcp: () => Effect.fail(new ProviderProtocolInvalid({ reason: "synthetic unavailable" })),
      });
      const result = await t.runSearch();
      expect(result.details.attemptedProviders).toStrictEqual(["exa", "parallel", "brave"]);
      expect(result.details.provider).toBe("brave");
      expect(t.requests[0]?.headers).toMatchObject({ "x-subscription-token": "stored-brave" });
    });

    test("ambient credentials route all three APIs and native stored credentials take precedence", async () => {
      vi.stubEnv("EXA_API_KEY", "ambient-exa");
      vi.stubEnv("PARALLEL_API_KEY", "ambient-parallel");
      vi.stubEnv("BRAVE_API_KEY", "ambient-brave");
      const t = await tools();
      for (const provider of ["exa", "parallel", "brave"] as const) {
        await t.runSearch(provider);
      }
      expect(t.requests.map((request) => request.headers)).toStrictEqual([
        expect.objectContaining({ "x-api-key": "ambient-exa" }),
        expect.objectContaining({ "x-api-key": "ambient-parallel" }),
        expect.objectContaining({ "x-subscription-token": "ambient-brave" }),
      ]);
      for (const provider of ["exa", "parallel", "brave"] as const) {
        await t.login(provider, `stored-${provider}`);
        await t.runSearch(provider);
        const storedRequest = t.requests.at(-1);
        assert(storedRequest !== undefined);
        expect(Object.values(storedRequest.headers)).toContain(`stored-${provider}`);
        await t.logout(provider);
        await t.runSearch(provider);
        const ambientRequest = t.requests.at(-1);
        assert(ambientRequest !== undefined);
        expect(Object.values(ambientRequest.headers)).toContain(`ambient-${provider}`);
      }
      expect(t.calls).toHaveLength(0);
    });

    test.each(["exa", "parallel"] as const)(
      "%s literal login and logout changes transport on the same tool",
      async (provider) => {
        const t = await tools();
        await t.runSearch(provider);
        const first = t.calls.at(-1);
        expect(first).toBeDefined();
        await t.login(provider, `${provider}-literal`);
        await t.runSearch(provider);
        expect(t.requests.at(-1)?.headers).toMatchObject({ "x-api-key": `${provider}-literal` });
        await t.logout(provider);
        await t.runSearch(provider);
        expect(t.calls).toHaveLength(2);
        expect(t.calls[1]?.args.session_id).toBe(first?.args.session_id);
      },
    );

    test.each([
      { provider: "exa" as const, key: "!exit 7" },
      { provider: "exa" as const, key: "!printf ''" },
      { provider: "parallel" as const, key: "!exit 7" },
      { provider: "parallel" as const, key: "!printf ''" },
    ])(
      "$provider command failure $key never downgrades to MCP or ambient credentials",
      async ({ provider, key }) => {
        vi.stubEnv(WEB_AUTH_PROVIDERS[provider].env, "ambient-not-a-fallback");
        const t = await tools({
          initial: { [WEB_AUTH_PROVIDERS[provider].id]: { type: "api_key", key } },
        });
        await expect(t.runSearch(provider)).rejects.toThrow("credential");
        expect(t.calls).toHaveLength(0);
        expect(t.requests).toHaveLength(0);
      },
    );

    test("endpoint overrides skip stored commands and never send keys", async () => {
      const t = await tools({
        settings: {
          PI_WEB_TOOLS_EXA_ENDPOINT: "https://example.com/exa",
          PI_WEB_TOOLS_PARALLEL_ENDPOINT: "https://example.com/parallel",
        },
        initial: {
          "pi-web-tools-exa": { type: "api_key", key: "!exit 7" },
          "pi-web-tools-parallel": { type: "api_key", key: "!exit 7" },
          "pi-web-tools-brave": { type: "api_key", key: "!exit 7" },
        },
      });
      const read = vi.spyOn(t.registry, "getProviderAuth");
      await t.runSearch("exa");
      await t.runSearch("parallel");
      expect(read).not.toHaveBeenCalled();
      expect(t.calls.map((call) => call.endpoint)).toStrictEqual([
        "https://example.com/exa",
        "https://example.com/parallel",
      ]);
      expect(t.calls.every((call) => call.secrets.length === 0)).toBe(true);
      expect(t.requests).toHaveLength(0);
    });

    test("keyed Exa rescue uses contents API; keyed Parallel rescue stays MCP with shared session", async () => {
      const t = await tools({
        settings: { PI_WEB_TOOLS_PROVIDERS: "exa" },
        http: () =>
          Effect.succeed({
            bodyText: JSON.stringify({
              results: [{ url: pageUrl, title: "rescued", text: "rescued contents" }],
            }),
          }),
      });
      await t.login("exa", "rescue-exa");
      expect(textOf(await t.runFetch())).toContain("rescued contents");
      expect(t.requests[0]?.url).toBe("https://api.exa.ai/contents");
      expect(t.requests[0]?.headers).toMatchObject({ "x-api-key": "rescue-exa" });
      const parallel = await tools({ settings: { PI_WEB_TOOLS_PROVIDERS: "parallel" } });
      await parallel.runSearch("parallel");
      await parallel.login("parallel", "rescue-parallel");
      await parallel.runFetch();
      await parallel.logout("parallel");
      await parallel.runSearch("parallel");
      expect(parallel.requests).toHaveLength(0);
      expect(parallel.calls.map((call) => call.name)).toStrictEqual([
        "web_search",
        "web_fetch",
        "web_search",
      ]);
      const sessions = parallel.calls.map((call) => call.args.session_id);
      expect(new Set(sessions).size).toBe(1);
      expect(sessions[0]).toStrictEqual(expect.any(String));
    });
  });

  describe("explicit native auth configuration", () => {
    test("explicit Brave must validate before a healthy Exa can hide its absence; override skips unused Brave", async () => {
      const t = await tools({ settings: { PI_WEB_TOOLS_PROVIDERS: "exa,brave" } });
      await t.login("exa", "healthy-exa");
      await expect(t.runSearch()).rejects.toThrow("credential unavailable");
      expect(t.requests).toHaveLength(0);
      await expect(t.runSearch("exa")).resolves.toMatchObject({ details: { provider: "exa" } });
      expect(t.requests).toHaveLength(1);
    });
  });

  describe("request-local native credential snapshots", () => {
    test.each([
      {
        cancel: (_controller: AbortController) => {
          /* finish both siblings */
        },
        expected: "[redacted]",
      },
      {
        cancel: (controller: AbortController) => {
          controller.abort();
        },
        expected: "Web search cancelled",
      },
    ])(
      "rotation with reversed completion and old sibling cancellation=%s",
      async ({ cancel, expected }) => {
        const arrivals = [deferred<undefined>(), deferred<undefined>()] as const;
        const responses = [
          deferred<ProviderHttpResponse>(),
          deferred<ProviderHttpResponse>(),
        ] as const;
        let index = 0;
        const t = await tools({
          http: () => {
            const current = index++;
            arrivals[current]?.resolve(undefined);
            const response = responses[current];
            assert(response !== undefined);
            return Effect.tryPromise({
              try: async () => response.promise,
              catch: () => new ProviderProtocolInvalid({ reason: "synthetic failure" }),
            });
          },
        });
        await t.login("exa", "old-synthetic-key");
        const updates: unknown[] = [];
        const controller = new AbortController();
        const old = t.search.execute(
          "old",
          { query: "old-synthetic-key", provider: "exa" },
          controller.signal,
          (update) => {
            updates.push(update);
          },
          t.context,
        );
        const oldOutcome = old.then((result) => result.details.query, errorMessage);
        await arrivals[0].promise;
        await t.login("exa", "new-synthetic-key");
        const newer = t.search.execute(
          "new",
          { query: "new-synthetic-key", provider: "exa" },
          undefined,
          (update) => {
            updates.push(update);
          },
          t.context,
        );
        await arrivals[1].promise;
        cancel(controller);
        responses[1].resolve({ bodyText: JSON.stringify(searchPayload("new-synthetic-key")) });
        const newResult = await newer;
        responses[0].resolve({ bodyText: JSON.stringify(searchPayload("old-synthetic-key")) });
        const previous = await oldOutcome;
        expect(t.requests.map((request) => request.headers["x-api-key"])).toStrictEqual([
          "old-synthetic-key",
          "new-synthetic-key",
        ]);
        expect(JSON.stringify({ newResult, previous, updates })).not.toContain("old-synthetic-key");
        expect(JSON.stringify({ newResult, previous, updates })).not.toContain("new-synthetic-key");
        expect(textOf(newResult)).toContain("[redacted]");
        expect(previous).toBe(expected);
      },
    );

    test("reflected credentials are redacted from fetch details, progress, content and spill files", async () => {
      const secret = "spill-synthetic-key";
      const t = await tools({
        settings: { PI_WEB_TOOLS_PROVIDERS: "exa" },
        http: () =>
          Effect.succeed({
            bodyText: JSON.stringify({
              results: [{ url: pageUrl, title: secret, text: `${secret} content\n`.repeat(5000) }],
            }),
          }),
      });
      await t.login("exa", secret);
      const updates: unknown[] = [];
      const result = await t.fetch.execute(
        "spill",
        { url: pageUrl },
        undefined,
        (update) => {
          updates.push(update);
        },
        t.context,
      );
      expect(JSON.stringify({ result, updates })).not.toContain(secret);
      expect(result.details.truncated).toBe(true);
      const path = result.details.fullOutputPath;
      expect(path).toStrictEqual(expect.any(String));
      assert(typeof path === "string");
      cleanup.push(async () => rm(path, { force: true }));
      const contents = await readFile(path, "utf8");
      expect(contents).not.toContain(secret);
      expect(contents).toContain("[redacted]");
    });

    test("reflected native keys are redacted from user-facing provider errors", async () => {
      const t = await tools({
        http: (request) =>
          Effect.fail(
            new ProviderProtocolInvalid({
              reason: `reflected ${request.headers["x-api-key"]}`,
            }),
          ),
      });
      await t.login("exa", "error-synthetic-key");
      await expect(t.runSearch("exa")).rejects.toThrow("returned an invalid response");
      await expect(t.runSearch("exa")).rejects.not.toThrow("error-synthetic-key");
    });

    test("the unavailable runtime resolver cannot substitute a global registry when context is omitted", async () => {
      const t = await tools();
      await t.login("exa", "context-required-key");
      await expect(
        t.search.execute("missing-context", { query: "query", provider: "exa" }),
      ).rejects.toThrow("credential unavailable");
      expect(t.requests).toHaveLength(0);
      expect(t.calls).toHaveLength(0);
    });

    test("session disposal interrupts in-flight provider I/O and rejects late tool calls", async () => {
      const entered = deferred<undefined>();
      const t = await tools({
        http: () => {
          entered.resolve(undefined);
          return Effect.never;
        },
      });
      await t.login("exa", "dispose-key");
      const pending = t.runSearch("exa");
      const outcome = pending.catch(errorMessage);
      await entered.promise;
      await t.runtime.dispose();
      await expect(outcome).resolves.toBe("Web search cancelled");
      await expect(t.runSearch("exa")).rejects.toThrow("Web search cancelled");
      expect(t.requests).toHaveLength(1);
    });
  });
});
