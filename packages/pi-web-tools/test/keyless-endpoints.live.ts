import { Effect, Result } from "effect";
import { assert, describe, expect, test } from "vitest";
import { McpHttpClient } from "../mcp";
import { ExaMcpFetchProvider, ExaMcpSearchProvider } from "../provider-exa";
import { ParallelMcpFetchProvider, ParallelMcpSearchProvider } from "../provider-parallel";
import {
  EXA_MCP_DEFAULT_ENDPOINT,
  PARALLEL_MCP_DEFAULT_ENDPOINT,
  SEARCH_MAX_RESPONSE_BYTES,
  SEARCH_TIMEOUT_SECONDS,
} from "../settings";
import { publicUrl, searchQuery } from "./fakes";

// Live smoke tests against the real keyless endpoints. Run with: npm run test:live
// (vitest.live.config.ts includes packages/*/test/**/*.live.ts and nothing else).

function makeMcp(endpoint: typeof EXA_MCP_DEFAULT_ENDPOINT): McpHttpClient {
  return new McpHttpClient(endpoint, {
    maxResponseBytes: SEARCH_MAX_RESPONSE_BYTES,
    timeoutMs: SEARCH_TIMEOUT_SECONDS.default * 1000,
  });
}

describe("live keyless endpoints", () => {
  test("exa MCP search returns results", async () => {
    const provider = new ExaMcpSearchProvider(makeMcp(EXA_MCP_DEFAULT_ENDPOINT));
    const result = await Effect.runPromise(
      Effect.result(
        provider.search({
          query: searchQuery("pi coding agent github"),
          maxResults: 3,
        }),
      ),
    );
    assert(Result.isSuccess(result));
    expect(result.success.length).toBeGreaterThan(0);
    expect(result.success[0]?.url).toMatch(/^https?:\/\//u);
  }, 30_000);

  test("parallel MCP search returns results", async () => {
    const provider = new ParallelMcpSearchProvider(
      makeMcp(PARALLEL_MCP_DEFAULT_ENDPOINT),
      crypto.randomUUID(),
    );
    const result = await Effect.runPromise(
      Effect.result(
        provider.search({
          query: searchQuery("pi coding agent github"),
          maxResults: 3,
        }),
      ),
    );
    assert(Result.isSuccess(result));
    expect(result.success.length).toBeGreaterThan(0);
  }, 30_000);

  test("exa MCP fetch reads a page", async () => {
    const provider = new ExaMcpFetchProvider(makeMcp(EXA_MCP_DEFAULT_ENDPOINT));
    const markdown = await Effect.runPromise(
      provider.fetchMarkdown(publicUrl("https://example.com")),
    );
    expect(markdown).toContain("Example Domain");
  }, 30_000);

  test("parallel MCP fetch reads a page", async () => {
    const provider = new ParallelMcpFetchProvider(
      makeMcp(PARALLEL_MCP_DEFAULT_ENDPOINT),
      crypto.randomUUID(),
    );
    const markdown = await Effect.runPromise(
      provider.fetchMarkdown(publicUrl("https://example.com")),
    );
    expect(markdown?.length).toBeGreaterThan(50);
  }, 30_000);
});
