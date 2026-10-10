import { Effect, Result, Duration } from "effect";
import { describe, expect, test } from "vitest";
import { withProviderDeadline } from "../provider-http";
import { ProviderRequestFailed } from "../provider-types";
import type { SearchProvider } from "../provider-types";
import { createWebSearchTool, EmptySearchQueryInput, parseWebSearchParams } from "../websearch";
import {
  publicUrl,
  renderText,
  settingsFrom,
  settleOnTestClock,
  textOf,
  toolRuntimeWith,
} from "./fakes";

const DEFAULT_SETTINGS = settingsFrom();

function answeringProvider(name: "exa" | "parallel" | "brave"): SearchProvider {
  return {
    name,
    transport: "mcp",
    search: () =>
      Effect.succeed([
        { title: `${name} result`, url: publicUrl("https://example.com/"), snippet: "a snippet" },
      ]),
  };
}

function failingProvider(name: "exa" | "parallel" | "brave"): SearchProvider {
  return {
    name,
    transport: "mcp",
    search: () =>
      Effect.fail(
        new ProviderRequestFailed({
          hostname: "search.example",
          cause: new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }),
        }),
      ),
  };
}

describe("parseWebSearchParams", () => {
  const settings = DEFAULT_SETTINGS;

  test("parses a minimal query with settings defaults", () => {
    expect(parseWebSearchParams({ query: " pi agent " }, settings)).toStrictEqual(
      Result.succeed({ query: "pi agent", maxResults: 8 }),
    );
  });

  test("rejects empty queries", () => {
    expect(parseWebSearchParams({ query: "   " }, settings)).toStrictEqual(
      Result.fail(new EmptySearchQueryInput()),
    );
  });

  test("clamps maxResults and keeps the provider override", () => {
    expect(
      parseWebSearchParams({ query: "x", maxResults: 100, provider: "parallel" }, settings),
    ).toStrictEqual(Result.succeed({ query: "x", maxResults: 20, provider: "parallel" }));
  });
});

describe("websearch tool", () => {
  test("returns results from the first healthy provider", async () => {
    const tool = createWebSearchTool({
      settings: DEFAULT_SETTINGS,
      runtime: toolRuntimeWith({
        settings: DEFAULT_SETTINGS,
        searchProviders: [failingProvider("exa"), answeringProvider("parallel")],
      }),
    });
    const result = await tool.execute("t1", { query: "pi agent" });

    expect(result.details.provider).toBe("parallel");
    expect(result.details.attemptedProviders).toStrictEqual(["exa", "parallel"]);
    expect(result.details.resultCount).toBe(1);
    expect(textOf(result)).toContain("parallel result");
  });

  test("provider override skips the rest of the chain", async () => {
    const tool = createWebSearchTool({
      settings: settingsFrom({ BRAVE_API_KEY: "BSA_test" }),
      runtime: toolRuntimeWith({
        settings: settingsFrom({ BRAVE_API_KEY: "BSA_test" }),
        secret: "BSA_test",
        searchProviders: [
          failingProvider("exa"),
          failingProvider("parallel"),
          answeringProvider("brave"),
        ],
      }),
    });
    const result = await tool.execute("t1", { query: "pi agent", provider: "brave" });
    expect(result.details.provider).toBe("brave");
    expect(result.details.attemptedProviders).toStrictEqual(["brave"]);
  });

  test("throws a safe message when every provider fails", async () => {
    const tool = createWebSearchTool({
      settings: DEFAULT_SETTINGS,
      runtime: toolRuntimeWith({
        settings: DEFAULT_SETTINGS,
        searchProviders: [failingProvider("exa"), failingProvider("parallel")],
      }),
    });
    await expect(tool.execute("t1", { query: "pi agent" })).rejects.toThrow(
      "All search providers failed",
    );
  });

  test("redacts secrets from search output", async () => {
    const leaky: SearchProvider = {
      name: "exa",
      transport: "mcp",
      search: () =>
        Effect.succeed([{ title: "leak sekrit-key", url: publicUrl("https://example.com/") }]),
    };
    const tool = createWebSearchTool({
      settings: DEFAULT_SETTINGS,
      runtime: toolRuntimeWith({
        settings: DEFAULT_SETTINGS,
        secret: "sekrit-key",
        searchProviders: [leaky],
      }),
    });
    const result = await tool.execute("t1", { query: "x" });
    expect(textOf(result)).not.toContain("sekrit-key");
    expect(textOf(result)).toContain("[redacted]");
  });
});

/** A websearch tool over a single provider. */
function toolWith(provider: SearchProvider) {
  return createWebSearchTool({
    settings: DEFAULT_SETTINGS,
    runtime: toolRuntimeWith({
      settings: DEFAULT_SETTINGS,
      searchProviders: [provider],
    }),
  });
}

describe("websearch deadline and cancellation", () => {
  test("a provider deadline reports the timeout, not a cancellation", async () => {
    // The provider applies its own deadline, as the real HTTP and MCP clients do.
    const slow: SearchProvider = {
      name: "exa",
      transport: "api",
      search: () => Effect.never.pipe(withProviderDeadline(Duration.millis(20))),
    };
    const runtime = toolRuntimeWith({
      settings: DEFAULT_SETTINGS,
      searchProviders: [slow],
      testClock: true,
    });
    const tool = createWebSearchTool({ settings: DEFAULT_SETTINGS, runtime });
    const outcome = tool.execute("t1", { query: "slow" });
    await settleOnTestClock(runtime, Duration.millis(20), outcome);
    await expect(outcome).rejects.toThrow("All search providers failed (exa: timed out after 1s)");
    await expect(outcome).rejects.not.toThrow("cancelled");
  });

  test("a caller abort reports a cancellation and stops the chain", async () => {
    const controller = new AbortController();
    let fallbackCalls = 0;
    const hanging: SearchProvider = { name: "exa", transport: "api", search: () => Effect.never };
    const fallback: SearchProvider = {
      name: "parallel",
      transport: "api",
      search: () =>
        Effect.sync(() => {
          fallbackCalls += 1;
          return [];
        }),
    };
    const tool = createWebSearchTool({
      settings: DEFAULT_SETTINGS,
      runtime: toolRuntimeWith({
        settings: DEFAULT_SETTINGS,
        searchProviders: [hanging, fallback],
      }),
    });
    const outcome = tool.execute("t1", { query: "q" }, controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 10);
    await expect(outcome).rejects.toThrow("Web search cancelled");
    expect(fallbackCalls).toBe(0);
  });
});

describe("websearch result rendering", () => {
  const theme = { fg: (_name: string, value: string) => value, bold: (value: string) => value };
  const tool = toolWith(answeringProvider("exa"));
  const details = {
    query: "q",
    maxResults: 8,
    resultCount: 1,
    provider: "exa" as const,
    attemptedProviders: ["exa" as const],
    truncated: false,
  };
  const render = (
    result: Parameters<typeof tool.renderResult>[0],
    options: { readonly expanded: boolean; readonly isPartial: boolean },
  ) => renderText(tool.renderResult(result, options, theme));

  test("shows progress while searching and the error text on failure", () => {
    expect(render({ content: [] }, { expanded: false, isPartial: true })).toBe("Searching...");
    expect(
      render(
        { content: [{ type: "text", text: "All search providers failed" }], isError: true },
        { expanded: false, isPartial: false },
      ),
    ).toBe("✗ All search providers failed");
    expect(render({ content: [], isError: true }, { expanded: false, isPartial: false })).toBe(
      "✗ Search failed",
    );
  });

  test("summarizes the count and provider, previewing results and the spill file when expanded", () => {
    const expanded = render(
      {
        content: [{ type: "text", text: "1. Result\n   URL: https://example.com/" }],
        details: { ...details, resultCount: 2, truncated: true, fullOutputPath: "/tmp/y" },
      },
      { expanded: true, isPartial: false },
    );
    expect(expanded.split("\n")[0]).toBe("✓ 2 results via exa [truncated]");
    expect(expanded).toContain("URL: https://example.com/");
    expect(expanded).toContain("Full output: /tmp/y");

    const single = render({ content: [], details }, { expanded: true, isPartial: false });
    expect(single).toBe("✓ 1 result via exa\n");
  });
});
