import { assert, describe, expect, it, test } from "@effect/vitest";
import { Duration, Effect, Layer, Result } from "effect";
import { CredentialFailure } from "../credentials";
import type { CredentialSnapshot } from "../credentials";
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
import {
  credentialSnapshotFrom,
  fakeProviderHttp,
  publicUrl,
  recordingMcpClients,
  searchQuery,
  settingsFrom,
} from "./fakes";

function failure(provider: "exa" | "parallel" | "brave") {
  return Result.fail(new CredentialFailure({ provider, reason: "resolution" }));
}

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
  env: Readonly<Record<string, string | undefined>>,
  mcpClients: ReturnType<typeof recordingMcpClients> = recordingMcpClients(),
) {
  const http = fakeProviderHttp([]);
  const dependencies = Layer.mergeAll(
    WebToolsConfig.layer(settingsFrom(env)),
    Layer.succeed(ProviderHttpClient, http.client),
    mcpClients.layer,
  );
  const chains = Layer.mergeAll(SearchProviders.layer, FetchRescueProviders.layer).pipe(
    Layer.provide(dependencies),
  );
  return Effect.runSync(
    Effect.gen(function* () {
      const search = yield* SearchProviders;
      const fetch = yield* FetchRescueProviders;
      const snapshot = credentialSnapshotFrom(env);
      return {
        search: search.forRequest(snapshot),
        fetch: fetch.forRequest(snapshot),
        http,
        searchService: search,
        fetchService: fetch,
      };
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
        'Provider "brave" is not enabled (`PI_WEB_PROVIDERS`). Available: exa, parallel.',
      );
    }),
  );
});

describe("buildSearchProviders", () => {
  test("keyless defaults build MCP providers for exa and parallel", () => {
    const env = {};
    const providers = buildChains(env).search;
    expect(providers.map((p) => [p.name, p.transport])).toStrictEqual([
      ["exa", "mcp"],
      ["parallel", "mcp"],
    ]);
  });

  test("keys switch exa and parallel to REST, brave joins the chain", () => {
    const env = {
      EXA_API_KEY: "exa-key",
      PARALLEL_API_KEY: "parallel-key",
      BRAVE_API_KEY: "brave-key",
    };
    const providers = buildChains(env).search;
    expect(providers.map((p) => [p.name, p.transport])).toStrictEqual([
      ["exa", "api"],
      ["parallel", "api"],
      ["brave", "api"],
    ]);
  });

  test("endpoint overrides force MCP and win over keys", () => {
    const env = {
      EXA_API_KEY: "exa-key",
      PI_WEB_EXA_ENDPOINT: "https://search.internal.example/mcp",
    };
    const providers = buildChains(env).search;
    expect(providers.map((p) => [p.name, p.transport])).toStrictEqual([
      ["exa", "mcp"],
      ["parallel", "mcp"],
    ]);
  });

  test.each([
    [{}, [true, true]],
    [{ EXA_API_KEY: "exa-key" }, [false, true]],
    [{ PI_WEB_EXA_ENDPOINT: "https://search.internal.example/mcp" }, [false, true]],
  ] as const)("only the default keyless endpoints are free tier: %j", (env, freeTier) => {
    const providers = buildChains(env).search;
    expect(providers.map((p) => p.freeTier === true)).toStrictEqual(freeTier);
  });
});

function freeTierProvider(error: ProviderError, name: "exa" | "parallel"): SearchProvider {
  return { ...failingProvider(error, name), transport: "mcp", freeTier: true };
}

const EXA_LIMIT = new ProviderToolError({
  detail: "You've hit Exa's free MCP rate limit. Create a free Exa account to get your own...",
});

describe("free-tier rate limits", () => {
  it.effect("says the free tier is rate limited and how to add a key", () =>
    Effect.gen(function* () {
      const providers = [
        freeTierProvider(EXA_LIMIT, "exa"),
        freeTierProvider(new ProviderStatusRejected({ status: 429 }), "parallel"),
      ];
      const result = yield* Effect.result(
        searchWithFallback(providers, { query: QUERY, maxResults: 8 }),
      );

      assert(Result.isFailure(result));
      assert(result.failure._tag === "AllProvidersFailed");
      expect(result.failure.message).toBe(
        "Free-tier rate limit on exa, parallel. Ask the user to add a key with `/login pi-web-exa`.",
      );
      expect(result.failure.attempts).toStrictEqual([
        "exa: free-tier rate limit; the user can add a key with `/login pi-web-exa`",
        "parallel: free-tier rate limit; the user can add a key with `/login pi-web-parallel`",
      ]);
    }),
  );

  it.effect("lists each reason when only some providers hit the free-tier limit", () =>
    Effect.gen(function* () {
      const providers = [
        freeTierProvider(EXA_LIMIT, "exa"),
        failingProvider(new ProviderTimedOut({ timeoutSeconds: 25 }), "parallel"),
      ];
      const result = yield* Effect.result(
        searchWithFallback(providers, { query: QUERY, maxResults: 8 }),
      );

      assert(Result.isFailure(result));
      expect(result.failure.message).toBe(
        "All search providers failed (exa: free-tier rate limit; the user can add a key with `/login pi-web-exa`; parallel: timed out after 25s)",
      );
    }),
  );

  it.effect("keeps the provider's own text when a keyed or overridden route is rate limited", () =>
    Effect.gen(function* () {
      const providers = [
        failingProvider(new ProviderStatusRejected({ status: 429 }), "exa"),
        { ...failingProvider(EXA_LIMIT, "parallel"), transport: "mcp" as const },
      ];
      const result = yield* Effect.result(
        searchWithFallback(providers, { query: QUERY, maxResults: 8 }),
      );

      assert(Result.isFailure(result));
      assert(result.failure._tag === "AllProvidersFailed");
      expect(result.failure.freeTierRateLimited).toBeUndefined();
      expect(result.failure.attempts).toStrictEqual([
        "exa: rejected (HTTP 429)",
        // The provider's own text, cut at the last word boundary within 70 characters.
        "parallel: reported an error: You've hit Exa's free MCP rate limit. Create a free Exa account to get…",
      ]);
    }),
  );

  it.effect("names the provider when a single-provider override hits the free-tier limit", () =>
    Effect.gen(function* () {
      const providers = [
        freeTierProvider(EXA_LIMIT, "exa"),
        freeTierProvider(new ProviderStatusRejected({ status: 429 }), "parallel"),
      ];
      const result = yield* Effect.result(
        searchWithFallback(
          providers,
          { query: QUERY, maxResults: 8 },
          { providerOverride: "parallel" },
        ),
      );

      assert(Result.isFailure(result));
      expect(result.failure.message).toBe(
        "Free-tier rate limit on parallel. Ask the user to add a key with `/login pi-web-parallel`.",
      );
    }),
  );

  it.effect("does not call other free-tier failures a rate limit", () =>
    Effect.gen(function* () {
      const providers = [freeTierProvider(new ProviderStatusRejected({ status: 503 }), "exa")];
      const result = yield* Effect.result(
        searchWithFallback(providers, { query: QUERY, maxResults: 8 }),
      );

      assert(Result.isFailure(result));
      expect(result.failure.message).toBe("All search providers failed (exa: rejected (HTTP 503))");
    }),
  );
});

/** The single attempt line for a provider whose tool reported `detail`. */
function attemptFor(error: ProviderError): Effect.Effect<string> {
  return Effect.gen(function* () {
    const result = yield* Effect.result(
      searchWithFallback([failingProvider(error)], { query: QUERY, maxResults: 8 }),
    );
    assert(Result.isFailure(result));
    assert(result.failure._tag === "AllProvidersFailed");
    const [attempt] = result.failure.attempts;
    assert(attempt !== undefined);
    return attempt;
  });
}

const DETAIL_PREFIX = "exa: reported an error: ";

describe("provider detail bounds", () => {
  it.effect("cuts a long provider detail at a word boundary", () =>
    Effect.gen(function* () {
      const detail = "alpha beta gamma delta ".repeat(10).trim();
      const attempt = yield* attemptFor(new ProviderToolError({ detail }));
      assert(attempt.startsWith(DETAIL_PREFIX));
      const shown = attempt.slice(DETAIL_PREFIX.length);
      expect(shown.endsWith("…")).toBe(true);
      const kept = shown.slice(0, -1);
      expect(kept.length).toBeLessThanOrEqual(70); // ASCII detail: one code unit per grapheme
      expect(detail.startsWith(kept)).toBe(true);
      expect(detail.charAt(kept.length)).toBe(" ");
    }),
  );

  it.effect("cuts whole code points when an emoji sits at the cut", () =>
    Effect.gen(function* () {
      // No spaces, so the cut falls inside the emoji run; each emoji is a surrogate pair.
      const detail = `${"x".repeat(60)}${"😀".repeat(30)}`;
      const attempt = yield* attemptFor(new ProviderToolError({ detail }));
      const shown = attempt.slice(DETAIL_PREFIX.length, -1);
      expect(shown).toBe(`${"x".repeat(60)}${"😀".repeat(9)}`);
      expect(shown).not.toMatch(/\p{Surrogate}/u);
      expect(shown.isWellFormed()).toBe(true);
    }),
  );

  it.effect("never splits the [URL omitted] placeholder", () =>
    Effect.gen(function* () {
      // The last space within the cap is the one inside "[URL omitted]".
      const detail = `${"word ".repeat(13)}[URL omitted] for details and more text after it`;
      const attempt = yield* attemptFor(new ProviderToolError({ detail }));
      const shown = attempt.slice(DETAIL_PREFIX.length);
      expect(shown).not.toContain("[URL…");
      expect(shown).toBe(`${"word ".repeat(12)}word…`);
    }),
  );

  it.effect("does not cut pi-web's own messages", () =>
    Effect.gen(function* () {
      const error = new CredentialFailure({ provider: "exa", reason: "incompatible" });
      const attempt = yield* attemptFor(error);
      expect(attempt).toBe(`exa: ${error.message}`);
      expect(attempt).toContain("`/reload`.");
    }),
  );
});

describe("provider route isolation", () => {
  it.effect("shared overrides stay keyless for search and rescue despite configured API keys", () =>
    Effect.gen(function* () {
      const env = {
        PI_WEB_PROVIDERS: "parallel,exa,brave",
        EXA_API_KEY: "exa-secret",
        PARALLEL_API_KEY: "parallel-secret",
        BRAVE_API_KEY: "brave-secret",
        PI_WEB_EXA_ENDPOINT: "https://override.example/mcp",
        PI_WEB_PARALLEL_ENDPOINT: "https://override.example/mcp",
      };
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
        WebToolsConfig.layer(settingsFrom(env)),
        Layer.succeed(ProviderHttpClient, http.client),
        McpClients.layerWith({ maxResponseBytes: 1024, timeout: Duration.seconds(1) }).pipe(
          Layer.provide(Layer.succeed(HttpFetch, { fetch: fetchImpl })),
        ),
      );
      const chains = Layer.mergeAll(SearchProviders.layer, FetchRescueProviders.layer).pipe(
        Layer.provide(dependencies),
      );
      yield* Effect.gen(function* () {
        const searchService = yield* SearchProviders;
        const rescueService = yield* FetchRescueProviders;
        const search = searchService.forRequest(credentialSnapshotFrom(env));
        const rescue = rescueService.forRequest(credentialSnapshotFrom(env));
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
        const rotated = credentialSnapshotFrom({
          ...env,
          EXA_API_KEY: "next-exa",
          PARALLEL_API_KEY: "next-parallel",
        });
        for (const provider of searchService
          .forRequest(rotated)
          .filter(({ name }) => name !== "brave")) {
          yield* provider.search({ query: QUERY, maxResults: 1 });
        }
        for (const provider of rescueService.forRequest(credentialSnapshotFrom({}))) {
          yield* provider.fetchMarkdown(publicUrl("https://page.example/"));
        }
      }).pipe(Effect.provide(chains));
      expect(http.requests).toStrictEqual([]);
      expect(outbound).toHaveLength(24);
      const parallelSessionIds = outbound.flatMap(({ body }) => {
        const match = /"session_id":"(?<sessionId>[^"]+)"/u.exec(body);
        return match?.groups?.sessionId ?? [];
      });
      expect(parallelSessionIds).toHaveLength(4);
      expect(new Set(parallelSessionIds).size).toBe(1);
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
    const env = {
      PI_WEB_PROVIDERS: "parallel,exa,brave",
      BRAVE_API_KEY: "brave-key",
    };
    const providers = buildChains(env).fetch;
    expect(providers.map((p) => p.name)).toStrictEqual(["parallel", "exa"]);
  });

  test("an exa key switches exa fetch to REST; parallel fetch stays on its MCP endpoint", () => {
    const env = { EXA_API_KEY: "exa-key", PARALLEL_API_KEY: "parallel-key" };
    const mcpClients = recordingMcpClients();
    const { endpoints } = mcpClients;
    const [exa, parallel] = buildChains(env, mcpClients).fetch;
    expect(exa).toBeInstanceOf(ExaApiFetchProvider);
    expect(parallel).toBeInstanceOf(ParallelMcpFetchProvider);
    expect(endpoints).toStrictEqual([
      "https://search.parallel.ai/mcp",
      "https://search.parallel.ai/mcp",
    ]);
  });

  test("endpoint overrides route both fetch providers to the override", () => {
    const env = {
      EXA_API_KEY: "exa-key",
      PI_WEB_EXA_ENDPOINT: "https://exa.internal.example/mcp",
      PI_WEB_PARALLEL_ENDPOINT: "https://parallel.internal.example/mcp",
    };
    const mcpClients = recordingMcpClients();
    const { endpoints } = mcpClients;
    const [exa, parallel] = buildChains(env, mcpClients).fetch;
    expect(exa).toBeInstanceOf(ExaMcpFetchProvider);
    expect(parallel).toBeInstanceOf(ParallelMcpFetchProvider);
    expect(endpoints).toStrictEqual([
      "https://exa.internal.example/mcp",
      "https://parallel.internal.example/mcp",
      "https://exa.internal.example/mcp",
      "https://parallel.internal.example/mcp",
    ]);
  });
});

describe("request-time routing", () => {
  test("Brave follows login, rotation and logout only in the default chain", () => {
    const { searchService } = buildChains({});
    const absent = credentialSnapshotFrom({});
    const old = credentialSnapshotFrom({ BRAVE_API_KEY: "old-key" });
    const next = credentialSnapshotFrom({ BRAVE_API_KEY: "new-key" });
    const names = (snapshot: CredentialSnapshot) =>
      searchService.forRequest(snapshot).map((p) => p.name);
    expect(names(absent)).toStrictEqual(["exa", "parallel"]);
    const oldProviders = searchService.forRequest(old);
    expect(names(next)).toStrictEqual(["exa", "parallel", "brave"]);
    expect(names(absent)).toStrictEqual(["exa", "parallel"]);
    expect(oldProviders.map((p) => p.name)).toStrictEqual(["exa", "parallel", "brave"]);
    expect(
      buildChains({ PI_WEB_PROVIDERS: "parallel" })
        .searchService.forRequest(next)
        .map((p) => p.name),
    ).toStrictEqual(["parallel"]);
  });

  it.effect("failed credentials stay candidates without invoking either transport or rescue", () =>
    Effect.gen(function* () {
      const mcp = recordingMcpClients();
      const { searchService, fetchService, http } = buildChains({}, mcp);
      mcp.endpoints.length = 0;
      const snapshot: CredentialSnapshot = {
        outcomes: { exa: failure("exa"), parallel: failure("parallel"), brave: failure("brave") },
        secrets: [],
      };
      const providers = searchService.forRequest(snapshot);
      expect(providers.map((p) => p.name)).toStrictEqual(["exa", "parallel", "brave"]);
      expect(fetchService.forRequest(snapshot)).toStrictEqual([]);
      const result = yield* Effect.result(
        searchWithFallback(providers, { query: QUERY, maxResults: 1 }),
      );
      assert(Result.isFailure(result));
      expect(result.failure.message).toContain("brave: credential resolution");
      expect(mcp.endpoints).toStrictEqual([]);
      expect(http.requests).toStrictEqual([]);
      const overridden = yield* Effect.result(
        searchWithFallback(
          providers,
          { query: QUERY, maxResults: 1 },
          { providerOverride: "brave" },
        ),
      );
      assert(Result.isFailure(overridden));
      expect(overridden.failure).toBeInstanceOf(AllProvidersFailed);
    }),
  );

  it.effect("explicit absent Brave fails safely instead of disappearing", () =>
    Effect.gen(function* () {
      const { search } = buildChains({ PI_WEB_PROVIDERS: "brave,parallel" });
      expect(search.map((p) => p.name)).toStrictEqual(["brave", "parallel"]);
      const result = yield* Effect.result(
        searchWithFallback(search, { query: QUERY, maxResults: 1 }, { providerOverride: "brave" }),
      );
      assert(Result.isFailure(result));
      expect(result.failure.message).toContain("brave: credential unavailable");
    }),
  );

  it.effect("new keyed adapters retain the old snapshot while sharing the HTTP client", () =>
    Effect.gen(function* () {
      const { searchService, http } = buildChains({ PI_WEB_PROVIDERS: "brave" });
      const old = searchService.forRequest(credentialSnapshotFrom({ BRAVE_API_KEY: "old-key" }));
      const next = searchService.forRequest(credentialSnapshotFrom({ BRAVE_API_KEY: "next-key" }));
      for (const provider of [...next, ...old]) {
        yield* Effect.result(provider.search({ query: QUERY, maxResults: 1 }));
      }
      expect(
        http.requests.map((request) => request.headers?.["x-subscription-token"]),
      ).toStrictEqual(["next-key", "old-key"]);
    }),
  );

  test("endpoint overrides ignore failed outcomes for search and rescue", () => {
    const { searchService, fetchService } = buildChains({
      PI_WEB_EXA_ENDPOINT: "https://override.example/exa",
      PI_WEB_PARALLEL_ENDPOINT: "https://override.example/parallel",
    });
    const snapshot: CredentialSnapshot = {
      outcomes: {
        ...credentialSnapshotFrom({}).outcomes,
        exa: Result.fail(new CredentialFailure({ provider: "exa", reason: "invalid" })),
        parallel: Result.fail(
          new CredentialFailure({ provider: "parallel", reason: "resolution" }),
        ),
      },
      secrets: [],
    };
    expect(searchService.forRequest(snapshot).map((p) => p.transport)).toStrictEqual([
      "mcp",
      "mcp",
    ]);
    expect(fetchService.forRequest(snapshot).map((p) => p.name)).toStrictEqual(["exa", "parallel"]);
  });
});
