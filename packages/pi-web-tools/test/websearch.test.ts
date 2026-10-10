import { validateToolArguments } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-ai";
import { Effect, Result } from "effect";
import { describe, expect, test } from "vitest";
import { withProviderDeadline } from "../provider-http";
import { ProviderRequestFailed } from "../provider-types";
import type { SearchProvider } from "../provider-types";
import { AllProvidersFailed, UnknownProvider } from "../search";
import { tempFileToolOutputStore } from "../tool-output";
import { createWebSearchTool, EmptySearchQueryInput, parseWebSearchParams } from "../websearch";
import { publicUrl, renderText, settingsFrom, textOf } from "./fakes";

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

describe("websearch parameter schema", () => {
  const tool = createWebSearchTool({
    settings: DEFAULT_SETTINGS,
    providers: [],
    outputStore: tempFileToolOutputStore,
    secrets: [],
  });

  function validate(args: unknown): unknown {
    return validateToolArguments(tool, {
      type: "toolCall",
      id: "t",
      name: tool.name,
      arguments: args as JsonObject,
    });
  }

  test("rejects structurally invalid arguments before execute runs", () => {
    expect(() => validate({ query: "x", depth: "deep" })).toThrow("depth");
    expect(() => validate({ query: "x", provider: "google" })).toThrow("provider");
    expect(() => validate({ query: "x", maxResults: "lots" })).toThrow("maxResults");
    expect(() => validate({})).toThrow("query");
    expect(() => validate(["x"])).toThrow("must be object");
  });

  test("accepts a provider override from the enum", () => {
    expect(validate({ query: "x", provider: "brave", maxResults: "3" })).toStrictEqual({
      query: "x",
      provider: "brave",
      maxResults: 3,
    });
  });
});

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
      providers: [failingProvider("exa"), answeringProvider("parallel")],
      outputStore: tempFileToolOutputStore,
      secrets: [],
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
      providers: [failingProvider("exa"), failingProvider("parallel"), answeringProvider("brave")],
      outputStore: tempFileToolOutputStore,
      secrets: ["BSA_test"],
    });
    const result = await tool.execute("t1", { query: "pi agent", provider: "brave" });
    expect(result.details.provider).toBe("brave");
    expect(result.details.attemptedProviders).toStrictEqual(["brave"]);
  });

  test("throws a safe message when every provider fails", async () => {
    const tool = createWebSearchTool({
      settings: DEFAULT_SETTINGS,
      providers: [failingProvider("exa"), failingProvider("parallel")],
      outputStore: tempFileToolOutputStore,
      secrets: [],
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
      providers: [leaky],
      outputStore: tempFileToolOutputStore,
      secrets: ["sekrit-key"],
    });
    const result = await tool.execute("t1", { query: "x" });
    expect(textOf(result)).not.toContain("sekrit-key");
    expect(textOf(result)).toContain("[redacted]");
  });
});

describe("websearch rendering", () => {
  const theme = { fg: (_name: string, value: string) => value, bold: (value: string) => value };
  const tool = createWebSearchTool({
    settings: DEFAULT_SETTINGS,
    providers: [answeringProvider("exa")],
    outputStore: tempFileToolOutputStore,
    secrets: [],
  });

  test("renderCall shows the query and provider", () => {
    const rendered = renderText(tool.renderCall({ query: "pi agent", provider: "exa" }, theme));
    expect(rendered).toContain("websearch");
    expect(rendered).toContain("pi agent");
    expect(rendered).toContain("(exa)");
  });

  test("renderResult handles partial, error, and expanded states", () => {
    expect(
      renderText(tool.renderResult({ content: [] }, { expanded: false, isPartial: true }, theme)),
    ).toContain("Searching");
    expect(
      renderText(
        tool.renderResult(
          { content: [{ type: "text", text: "nope" }], isError: true },
          { expanded: false, isPartial: false },
          theme,
        ),
      ),
    ).toContain("nope");
    const expanded = renderText(
      tool.renderResult(
        {
          content: [{ type: "text", text: "results" }],
          details: {
            query: "q",
            maxResults: 8,
            resultCount: 2,
            provider: "exa" as const,
            attemptedProviders: ["exa" as const],
            truncated: true,
            fullOutputPath: "/tmp/y",
          },
        },
        { expanded: true, isPartial: false },
        theme,
      ),
    );
    expect(expanded).toContain("2 results");
    expect(expanded).toContain("via exa");
    expect(expanded).toContain("Full output: /tmp/y");
  });
});

describe("search chain error messages", () => {
  test("render unknown providers and aggregate failures", () => {
    expect(new UnknownProvider({ provider: "brave", available: ["exa"] }).message).toBe(
      'Provider "brave" is not enabled. Available: exa',
    );
    expect(new AllProvidersFailed({ attempts: ["exa: unavailable"] }).message).toBe(
      "All search providers failed (exa: unavailable)",
    );
  });
});

/** A websearch tool over a single provider. */
function toolWith(provider: SearchProvider) {
  return createWebSearchTool({
    settings: DEFAULT_SETTINGS,
    providers: [provider],
    outputStore: tempFileToolOutputStore,
    secrets: [],
  });
}

describe("websearch deadline and cancellation", () => {
  test("a provider deadline reports the timeout, not a cancellation", async () => {
    // The provider applies its own deadline, as the real HTTP and MCP clients do.
    const slow: SearchProvider = {
      name: "exa",
      transport: "api",
      search: () => Effect.never.pipe(withProviderDeadline(20)),
    };
    const outcome = toolWith(slow).execute("t1", { query: "slow" });
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
      providers: [hanging, fallback],
      outputStore: tempFileToolOutputStore,
      secrets: [],
    });
    const outcome = tool.execute("t1", { query: "q" }, controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 10);
    await expect(outcome).rejects.toThrow("Web search cancelled");
    expect(fallbackCalls).toBe(0);
  });
});
