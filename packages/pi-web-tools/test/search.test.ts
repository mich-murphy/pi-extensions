import { assert, describe, expect, it, test } from "@effect/vitest";
import { Duration, Effect, Layer, Result } from "effect";
import { McpClients } from "../mcp";
import { HttpFetch } from "../network";
import { ExaApiFetchProvider, ExaMcpFetchProvider } from "../provider-exa";
import { ProviderHttpClient } from "../provider-http";
import { ParallelMcpFetchProvider } from "../provider-parallel";
import {
  ProviderProtocolInvalid,
  ProviderRequestFailed,
  ProviderResponseTooLarge,
  ProviderStatusRejected,
  ProviderTimedOut,
  ProviderToolError,
} from "../provider-types";
import type { ProviderError, SearchProvider } from "../provider-types";
import {
  AllProvidersFailed,
  FetchRescueProviders,
  searchWithFallback,
  SearchProviders,
  UnknownProvider,
} from "../search";
import { WebToolsConfig } from "../settings";
import type { WebToolsSettings } from "../settings";
import {
  fakeProviderHttp,
  publicUrl,
  recordingMcpClients,
  searchQuery,
  settingsFrom,
} from "./fakes";

const QUERY = searchQuery("test query");

function answeringProvider(name: "exa" | "parallel" | "brave"): SearchProvider {
  return {
    name,
    transport: "mcp",
    search: () =>
      Effect.succeed([{ title: `${name} result`, url: publicUrl("https://example.com") }]),
  };
}

function failingProvider(
  error: ProviderError,
  name: "exa" | "parallel" | "brave" = "exa",
): SearchProvider {
  return { name, transport: "api", search: () => Effect.fail(error) };
}

const UNAVAILABLE: ProviderError = new ProviderRequestFailed({
  hostname: "mcp.example",
  cause: new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }),
});

function buildChains(
  settings: WebToolsSettings,
  mcpClients: ReturnType<typeof recordingMcpClients> = recordingMcpClients(),
) {
  const dependencies = Layer.mergeAll(
    WebToolsConfig.layer(settings),
    Layer.succeed(ProviderHttpClient, fakeProviderHttp([]).client),
    mcpClients.layer,
  );
  const chains = Layer.mergeAll(SearchProviders.layer, FetchRescueProviders.layer).pipe(
    Layer.provide(dependencies),
  );
  return Effect.runSync(
    Effect.gen(function* () {
      return { search: yield* SearchProviders, fetch: yield* FetchRescueProviders };
    }).pipe(Effect.provide(chains)),
  );
}

describe("searchWithFallback", () => {
  it.effect("aggregates failures with safe reasons when all providers fail", () =>
    Effect.gen(function* () {
      const providers = [
        failingProvider(UNAVAILABLE, "exa"),
        failingProvider(UNAVAILABLE, "parallel"),
      ];
      const result = yield* Effect.result(
        searchWithFallback(providers, { query: QUERY, maxResults: 8 }),
      );

      assert(Result.isFailure(result));
      expect(result.failure).toStrictEqual(
        new AllProvidersFailed({
          attempts: [
            "exa: could not resolve host mcp.example",
            "parallel: could not resolve host mcp.example",
          ],
        }),
      );
      expect(result.failure.message).toBe(
        "All search providers failed (exa: could not resolve host mcp.example; parallel: could not resolve host mcp.example)",
      );
    }),
  );

  it.effect("renders every provider failure as a safe reason", () =>
    Effect.gen(function* () {
      const errors: ProviderError[] = [
        new ProviderRequestFailed({ hostname: "mcp.exa.ai" }),
        new ProviderRequestFailed({
          hostname: "mcp.exa.ai",
          cause: { code: "CERT_HAS_EXPIRED" },
        }),
        new ProviderTimedOut({ timeoutSeconds: 25 }),
        new ProviderStatusRejected({ status: 429 }),
        new ProviderProtocolInvalid({ reason: "Missing results array" }),
        new ProviderResponseTooLarge(),
        new ProviderToolError({ detail: "" }),
        new ProviderToolError({ detail: "quota exceeded" }),
      ];
      const providers = errors.map((error) => failingProvider(error));
      const result = yield* Effect.result(
        searchWithFallback(providers, { query: QUERY, maxResults: 8 }),
      );

      assert(Result.isFailure(result));
      assert(result.failure._tag === "AllProvidersFailed");
      expect(result.failure.attempts).toStrictEqual([
        "exa: request to mcp.exa.ai failed",
        "exa: TLS certificate error for mcp.exa.ai (CERT_HAS_EXPIRED)",
        "exa: timed out after 25s",
        "exa: rejected (HTTP 429)",
        "exa: returned an invalid response",
        "exa: response too large",
        "exa: reported an error",
        "exa: reported an error: quota exceeded",
      ]);
    }),
  );

  it.effect("tries providers in order, stopping at the first success", () =>
    Effect.gen(function* () {
      const order: string[] = [];
      const tracked = (provider: SearchProvider): SearchProvider => ({
        ...provider,
        search: (input) =>
          Effect.suspend(() => {
            order.push(provider.name);
            return provider.search(input);
          }),
      });
      const providers = [
        tracked(failingProvider(new ProviderStatusRejected({ status: 500 }), "brave")),
        tracked(failingProvider(new ProviderTimedOut({ timeoutSeconds: 3 }), "exa")),
        tracked(answeringProvider("parallel")),
        tracked(answeringProvider("brave")),
      ];
      const result = yield* Effect.result(
        searchWithFallback(providers, { query: QUERY, maxResults: 8 }),
      );
      assert(Result.isSuccess(result));
      expect(result.success.provider).toBe("parallel");
      expect(order).toStrictEqual(["brave", "exa", "parallel"]);
      expect(result.success.attemptedProviders).toStrictEqual(["brave", "exa", "parallel"]);
    }),
  );

  it.effect("honors the provider override and rejects unknown providers", () =>
    Effect.gen(function* () {
      const providers = [failingProvider(UNAVAILABLE, "exa"), answeringProvider("parallel")];
      const overridden = yield* Effect.result(
        searchWithFallback(
          providers,
          { query: QUERY, maxResults: 8 },
          { providerOverride: "parallel" },
        ),
      );
      assert(Result.isSuccess(overridden));
      expect(overridden.success.provider).toBe("parallel");

      const unknown = yield* Effect.result(
        searchWithFallback(
          providers,
          { query: QUERY, maxResults: 8 },
          { providerOverride: "brave" },
        ),
      );
      expect(unknown).toStrictEqual(
        Result.fail(new UnknownProvider({ provider: "brave", available: ["exa", "parallel"] })),
      );
      assert(Result.isFailure(unknown));
      expect(unknown.failure.message).toBe(
        'Provider "brave" is not enabled. Available: exa, parallel',
      );
    }),
  );
});

describe("buildSearchProviders", () => {
  test("keyless defaults build MCP providers for exa and parallel", () => {
    const settings = settingsFrom({});
    const providers = buildChains(settings).search;
    expect(providers.map((p) => [p.name, p.transport])).toStrictEqual([
      ["exa", "mcp"],
      ["parallel", "mcp"],
    ]);
  });

  test("keys switch exa and parallel to REST, brave joins the chain", () => {
    const settings = settingsFrom({
      EXA_API_KEY: "exa-key",
      PARALLEL_API_KEY: "parallel-key",
      BRAVE_API_KEY: "brave-key",
    });
    const providers = buildChains(settings).search;
    expect(providers.map((p) => [p.name, p.transport])).toStrictEqual([
      ["exa", "api"],
      ["parallel", "api"],
      ["brave", "api"],
    ]);
  });

  test("endpoint overrides force MCP and win over keys", () => {
    const settings = settingsFrom({
      EXA_API_KEY: "exa-key",
      PI_WEB_TOOLS_EXA_ENDPOINT: "https://search.internal.example/mcp",
    });
    const providers = buildChains(settings).search;
    expect(providers.map((p) => [p.name, p.transport])).toStrictEqual([
      ["exa", "mcp"],
      ["parallel", "mcp"],
    ]);
  });
});

describe("provider route isolation", () => {
  it.effect("shared overrides stay keyless for search and rescue despite configured API keys", () =>
    Effect.gen(function* () {
      const settings = settingsFrom({
        PI_WEB_TOOLS_PROVIDERS: "parallel,exa,brave",
        EXA_API_KEY: "exa-secret",
        PARALLEL_API_KEY: "parallel-secret",
        BRAVE_API_KEY: "brave-secret",
        PI_WEB_TOOLS_EXA_ENDPOINT: "https://override.example/mcp",
        PI_WEB_TOOLS_PARALLEL_ENDPOINT: "https://override.example/mcp",
      });
      const outbound: { url: string; headers: Headers; body: string }[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        let url: string;
        if (typeof input === "string") {
          url = input;
        } else {
          url = input instanceof URL ? input.href : input.url;
        }
        outbound.push({
          url,
          headers: new Headers(init?.headers),
          body: typeof init?.body === "string" ? init.body : "",
        });
        return new Response(
          JSON.stringify({ result: { content: [], structuredContent: { results: [] } } }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      };
      const http = fakeProviderHttp([]);
      const dependencies = Layer.mergeAll(
        WebToolsConfig.layer(settings),
        Layer.succeed(ProviderHttpClient, http.client),
        McpClients.layerWith({ maxResponseBytes: 1024, timeout: Duration.seconds(1) }).pipe(
          Layer.provide(Layer.succeed(HttpFetch, { fetch: fetchImpl })),
        ),
      );
      const chains = Layer.mergeAll(SearchProviders.layer, FetchRescueProviders.layer).pipe(
        Layer.provide(dependencies),
      );
      yield* Effect.gen(function* () {
        const search = yield* SearchProviders;
        const rescue = yield* FetchRescueProviders;
        expect(search.map(({ name, transport }) => [name, transport])).toStrictEqual([
          ["parallel", "mcp"],
          ["exa", "mcp"],
          ["brave", "api"],
        ]);
        expect(rescue.map(({ name }) => name)).toStrictEqual(["parallel", "exa"]);
        for (const provider of search.filter(({ name }) => name !== "brave")) {
          yield* provider.search({ query: QUERY, maxResults: 1 });
        }
        for (const provider of rescue) {
          yield* provider.fetchMarkdown(publicUrl("https://page.example/"));
        }
      }).pipe(Effect.provide(chains));
      expect(http.requests).toStrictEqual([]);
      expect(outbound).toHaveLength(12);
      const parallelSessionIds = outbound.flatMap(({ body }) => {
        const match = /"session_id":"(?<sessionId>[^"]+)"/u.exec(body);
        return match?.groups?.sessionId ?? [];
      });
      expect(parallelSessionIds).toHaveLength(2);
      expect(parallelSessionIds[0]).toBe(parallelSessionIds[1]);
      for (const request of outbound) {
        expect(request.url).toBe("https://override.example/mcp");
        expect(request.headers.has("authorization")).toBe(false);
        expect(request.headers.has("x-api-key")).toBe(false);
        expect(request.body).not.toContain("secret");
      }
    }),
  );
});

describe("buildFetchProviders", () => {
  test("excludes brave and follows search priority order", () => {
    const settings = settingsFrom({
      PI_WEB_TOOLS_PROVIDERS: "parallel,exa,brave",
      BRAVE_API_KEY: "brave-key",
    });
    const providers = buildChains(settings).fetch;
    expect(providers.map((p) => p.name)).toStrictEqual(["parallel", "exa"]);
  });

  test("an exa key switches exa fetch to REST; parallel fetch stays on its MCP endpoint", () => {
    const settings = settingsFrom({ EXA_API_KEY: "exa-key", PARALLEL_API_KEY: "parallel-key" });
    const mcpClients = recordingMcpClients();
    const { endpoints } = mcpClients;
    const [exa, parallel] = buildChains(settings, mcpClients).fetch;
    expect(exa).toBeInstanceOf(ExaApiFetchProvider);
    expect(parallel).toBeInstanceOf(ParallelMcpFetchProvider);
    expect(endpoints).toStrictEqual(["https://search.parallel.ai/mcp"]);
  });

  test("endpoint overrides route both fetch providers to the override", () => {
    const settings = settingsFrom({
      EXA_API_KEY: "exa-key",
      PI_WEB_TOOLS_EXA_ENDPOINT: "https://exa.internal.example/mcp",
      PI_WEB_TOOLS_PARALLEL_ENDPOINT: "https://parallel.internal.example/mcp",
    });
    const mcpClients = recordingMcpClients();
    const { endpoints } = mcpClients;
    const [exa, parallel] = buildChains(settings, mcpClients).fetch;
    expect(exa).toBeInstanceOf(ExaMcpFetchProvider);
    expect(parallel).toBeInstanceOf(ParallelMcpFetchProvider);
    expect(endpoints).toStrictEqual([
      "https://exa.internal.example/mcp",
      "https://parallel.internal.example/mcp",
    ]);
  });
});
