import { describe, expect, test } from "vitest";
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
import { parseSettings } from "../settings";
import type { PublicHttpUrl, SearchQuery } from "../types";
import { fakeProviderHttp } from "./fakes";

const QUERY = "test query" as SearchQuery;

function fakeProvider(name: "exa" | "parallel" | "brave", outcome: "ok" | "fail"): SearchProvider {
  return {
    name,
    transport: "mcp",
    search: () =>
      Promise.resolve(
        outcome === "ok"
          ? ok([{ title: `${name} result`, url: "https://example.com" as never }])
          : err({ _tag: "ProviderRequestFailed" } as const),
      ),
  };
}

function failingProvider(error: ProviderError): SearchProvider {
  return { name: "exa", transport: "api", search: () => Promise.resolve(err(error)) };
}

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
      fakeProvider("exa", "fail"),
      fakeProvider("parallel", "ok"),
      fakeProvider("brave", "ok"),
    ];
    const result = await searchWithFallback(providers, { query: QUERY, maxResults: 8 });

    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(result.value.provider).toBe("parallel");
    expect(result.value.attemptedProviders).toEqual(["exa", "parallel"]);
  });

  test("aggregates failures with safe reasons when all providers fail", async () => {
    const providers = [fakeProvider("exa", "fail"), fakeProvider("parallel", "fail")];
    const result = await searchWithFallback(providers, { query: QUERY, maxResults: 8 });

    expect(result._tag).toBe("err");
    if (result._tag !== "err") return;
    expect(result.error._tag).toBe("AllProvidersFailed");
    if (result.error._tag !== "AllProvidersFailed") return;
    expect(result.error.attempts).toEqual(["exa: unavailable", "parallel: unavailable"]);
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
    const result = await searchWithFallback(errors.map(failingProvider), {
      query: QUERY,
      maxResults: 8,
    });

    expect(result._tag).toBe("err");
    if (result._tag !== "err" || result.error._tag !== "AllProvidersFailed") return;
    expect(result.error.attempts).toEqual([
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
    const providers = [fakeProvider("exa", "fail"), fakeProvider("parallel", "ok")];
    const overridden = await searchWithFallback(
      providers,
      { query: QUERY, maxResults: 8 },
      { providerOverride: "parallel" },
    );
    expect(overridden._tag).toBe("ok");
    if (overridden._tag !== "ok") return;
    expect(overridden.value.provider).toBe("parallel");

    const unknown = await searchWithFallback(
      providers,
      { query: QUERY, maxResults: 8 },
      { providerOverride: "brave" },
    );
    expect(unknown._tag).toBe("err");
    if (unknown._tag !== "err") return;
    expect(unknown.error._tag).toBe("UnknownProvider");
  });
});

describe("buildSearchProviders", () => {
  const { client } = fakeProviderHttp([]);

  test("keyless defaults build MCP providers for exa and parallel", () => {
    const settings = parseSettings({});
    if (settings._tag !== "ok") throw new Error("settings parse failed");
    const providers = buildSearchProviders({
      settings: settings.value,
      http: client,
      sessionId: "s",
      mcpFor: defaultMcpFor,
    });
    expect(providers.map((p) => [p.name, p.transport])).toEqual([
      ["exa", "mcp"],
      ["parallel", "mcp"],
    ]);
  });

  test("keys switch exa and parallel to REST, brave joins the chain", () => {
    const settings = parseSettings({
      EXA_API_KEY: "exa-key",
      PARALLEL_API_KEY: "parallel-key",
      BRAVE_API_KEY: "brave-key",
    });
    if (settings._tag !== "ok") throw new Error("settings parse failed");
    const providers = buildSearchProviders({
      settings: settings.value,
      http: client,
      sessionId: "s",
      mcpFor: defaultMcpFor,
    });
    expect(providers.map((p) => [p.name, p.transport])).toEqual([
      ["exa", "api"],
      ["parallel", "api"],
      ["brave", "api"],
    ]);
  });

  test("endpoint overrides force MCP and win over keys", () => {
    const settings = parseSettings({
      EXA_API_KEY: "exa-key",
      PI_WEB_TOOLS_EXA_ENDPOINT: "https://search.internal.example/mcp",
    });
    if (settings._tag !== "ok") throw new Error("settings parse failed");
    const providers = buildSearchProviders({
      settings: settings.value,
      http: client,
      sessionId: "s",
      mcpFor: defaultMcpFor,
    });
    expect(providers.map((p) => [p.name, p.transport])).toEqual([
      ["exa", "mcp"],
      ["parallel", "mcp"],
    ]);
  });
});

describe("buildFetchProviders", () => {
  const { client } = fakeProviderHttp([]);

  test("excludes brave and follows search priority order", () => {
    const settings = parseSettings({
      PI_WEB_TOOLS_PROVIDERS: "parallel,exa,brave",
      BRAVE_API_KEY: "brave-key",
    });
    if (settings._tag !== "ok") throw new Error("settings parse failed");
    const providers = buildFetchProviders({
      settings: settings.value,
      http: client,
      sessionId: "s",
      mcpFor: defaultMcpFor,
    });
    expect(providers.map((p) => p.name)).toEqual(["parallel", "exa"]);
  });

  test("an exa key switches exa fetch to REST; parallel fetch stays on its MCP endpoint", () => {
    const settings = parseSettings({ EXA_API_KEY: "exa-key", PARALLEL_API_KEY: "parallel-key" });
    if (settings._tag !== "ok") throw new Error("settings parse failed");
    const { endpoints, mcpFor } = recordingMcpFor();
    const [exa, parallel] = buildFetchProviders({
      settings: settings.value,
      http: client,
      sessionId: "s",
      mcpFor,
    });
    expect(exa).toBeInstanceOf(ExaApiFetchProvider);
    expect(parallel).toBeInstanceOf(ParallelMcpFetchProvider);
    expect(endpoints).toEqual(["https://search.parallel.ai/mcp"]);
  });

  test("endpoint overrides route both fetch providers to the override", () => {
    const settings = parseSettings({
      EXA_API_KEY: "exa-key",
      PI_WEB_TOOLS_EXA_ENDPOINT: "https://exa.internal.example/mcp",
      PI_WEB_TOOLS_PARALLEL_ENDPOINT: "https://parallel.internal.example/mcp",
    });
    if (settings._tag !== "ok") throw new Error("settings parse failed");
    const { endpoints, mcpFor } = recordingMcpFor();
    const [exa, parallel] = buildFetchProviders({
      settings: settings.value,
      http: client,
      sessionId: "s",
      mcpFor,
    });
    expect(exa).toBeInstanceOf(ExaMcpFetchProvider);
    expect(parallel).toBeInstanceOf(ParallelMcpFetchProvider);
    // One MCP client per provider, shared by its search and fetch sides.
    expect(endpoints).toEqual([
      "https://exa.internal.example/mcp",
      "https://parallel.internal.example/mcp",
    ]);
  });
});
