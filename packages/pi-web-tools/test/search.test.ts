import { assert, describe, expect, test } from "vitest";
import { ExaApiFetchProvider, ExaMcpFetchProvider } from "../provider-exa";
import { ParallelMcpFetchProvider } from "../provider-parallel";
import type { ProviderError, SearchProvider } from "../provider-types";
import { err, ok } from "../result";
import {
  buildFetchProviders,
  buildSearchProviders,
  defaultMcpFor,
  searchWithFallback,
} from "../search";
import type { PublicHttpUrl } from "../types";
import { fakeProviderHttp, publicUrl, searchQuery, settingsFrom } from "./fakes";

const QUERY = searchQuery("test query");

function answeringProvider(name: "exa" | "parallel" | "brave"): SearchProvider {
  return {
    name,
    transport: "mcp",
    search: async () => ok([{ title: `${name} result`, url: publicUrl("https://example.com") }]),
  };
}

function failingProvider(
  error: ProviderError,
  name: "exa" | "parallel" | "brave" = "exa",
): SearchProvider {
  return { name, transport: "api", search: async () => err(error) };
}

const UNAVAILABLE: ProviderError = { _tag: "ProviderRequestFailed" };

function recordingMcpFor() {
  const endpoints: PublicHttpUrl[] = [];
  return {
    endpoints,
    mcpFor: (endpoint: PublicHttpUrl) => {
      endpoints.push(endpoint);
      return defaultMcpFor(endpoint);
    },
  };
}

describe("searchWithFallback", () => {
  test("returns the first successful provider in priority order", async () => {
    const providers = [
      failingProvider(UNAVAILABLE, "exa"),
      answeringProvider("parallel"),
      answeringProvider("brave"),
    ];
    const result = await searchWithFallback(providers, { query: QUERY, maxResults: 8 });

    assert(result._tag === "ok");
    expect(result.value.provider).toBe("parallel");
    expect(result.value.attemptedProviders).toStrictEqual(["exa", "parallel"]);
  });

  test("aggregates failures with safe reasons when all providers fail", async () => {
    const providers = [
      failingProvider(UNAVAILABLE, "exa"),
      failingProvider(UNAVAILABLE, "parallel"),
    ];
    const result = await searchWithFallback(providers, { query: QUERY, maxResults: 8 });

    assert(result._tag === "err");
    assert(result.error._tag === "AllProvidersFailed");
    expect(result.error.attempts).toStrictEqual(["exa: unavailable", "parallel: unavailable"]);
  });

  test("renders every provider failure as a safe reason", async () => {
    const errors: ProviderError[] = [
      { _tag: "ProviderRequestFailed" },
      { _tag: "ProviderTimedOut", timeoutSeconds: 25 },
      { _tag: "ProviderCancelled" },
      { _tag: "ProviderStatusRejected", status: 429 },
      { _tag: "ProviderProtocolInvalid", reason: "Missing results array" },
      { _tag: "ProviderResponseTooLarge" },
      { _tag: "ProviderToolError" },
    ];
    const providers = errors.map((error) => failingProvider(error));
    const result = await searchWithFallback(providers, { query: QUERY, maxResults: 8 });

    assert(result._tag === "err");
    assert(result.error._tag === "AllProvidersFailed");
    expect(result.error.attempts).toStrictEqual([
      "exa: unavailable",
      "exa: timed out after 25s",
      "exa: cancelled",
      "exa: rejected (HTTP 429)",
      "exa: returned an invalid response",
      "exa: response too large",
      "exa: reported an error",
    ]);
  });

  test("honors the provider override and rejects unknown providers", async () => {
    const providers = [failingProvider(UNAVAILABLE, "exa"), answeringProvider("parallel")];
    const overridden = await searchWithFallback(
      providers,
      { query: QUERY, maxResults: 8 },
      { providerOverride: "parallel" },
    );
    assert(overridden._tag === "ok");
    expect(overridden.value.provider).toBe("parallel");

    const unknown = await searchWithFallback(
      providers,
      { query: QUERY, maxResults: 8 },
      { providerOverride: "brave" },
    );
    assert(unknown._tag === "err");
    expect(unknown.error._tag).toBe("UnknownProvider");
  });
});

describe("buildSearchProviders", () => {
  const { client } = fakeProviderHttp([]);

  test("keyless defaults build MCP providers for exa and parallel", () => {
    const settings = settingsFrom({});
    const providers = buildSearchProviders({
      settings,
      http: client,
      sessionId: "s",
      mcpFor: defaultMcpFor,
    });
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
    const providers = buildSearchProviders({
      settings,
      http: client,
      sessionId: "s",
      mcpFor: defaultMcpFor,
    });
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
    const providers = buildSearchProviders({
      settings,
      http: client,
      sessionId: "s",
      mcpFor: defaultMcpFor,
    });
    expect(providers.map((p) => [p.name, p.transport])).toStrictEqual([
      ["exa", "mcp"],
      ["parallel", "mcp"],
    ]);
  });
});

describe("buildFetchProviders", () => {
  const { client } = fakeProviderHttp([]);

  test("excludes brave and follows search priority order", () => {
    const settings = settingsFrom({
      PI_WEB_TOOLS_PROVIDERS: "parallel,exa,brave",
      BRAVE_API_KEY: "brave-key",
    });
    const providers = buildFetchProviders({
      settings,
      http: client,
      sessionId: "s",
      mcpFor: defaultMcpFor,
    });
    expect(providers.map((p) => p.name)).toStrictEqual(["parallel", "exa"]);
  });

  test("an exa key switches exa fetch to REST; parallel fetch stays on its MCP endpoint", () => {
    const settings = settingsFrom({ EXA_API_KEY: "exa-key", PARALLEL_API_KEY: "parallel-key" });
    const { endpoints, mcpFor } = recordingMcpFor();
    const [exa, parallel] = buildFetchProviders({
      settings,
      http: client,
      sessionId: "s",
      mcpFor,
    });
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
    const { endpoints, mcpFor } = recordingMcpFor();
    const [exa, parallel] = buildFetchProviders({
      settings,
      http: client,
      sessionId: "s",
      mcpFor,
    });
    expect(exa).toBeInstanceOf(ExaMcpFetchProvider);
    expect(parallel).toBeInstanceOf(ParallelMcpFetchProvider);
    // One MCP client per provider, shared by its search and fetch sides.
    expect(endpoints).toStrictEqual([
      "https://exa.internal.example/mcp",
      "https://parallel.internal.example/mcp",
    ]);
  });
});
