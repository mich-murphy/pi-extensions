import { assert, describe, expect, it, test } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
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

/** Build both provider chains from settings in one layer build, as the extension does. */
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
    // One MCP client per provider, shared by its search and fetch sides.
    expect(endpoints).toStrictEqual([
      "https://exa.internal.example/mcp",
      "https://parallel.internal.example/mcp",
    ]);
  });
});
