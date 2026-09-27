import { type JsonObject, validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import type { SearchProvider } from "../provider-types";
import { err, ok } from "../result";
import { parseSettings } from "../settings";
import { TempFileToolOutputStore } from "../tool-output";
import { createWebSearchTool, parseWebSearchParams, renderSearchChainError } from "../websearch";
import { renderText, textOf } from "./fakes";

function settingsWith(env: Record<string, string>) {
  const parsed = parseSettings(env);
  if (parsed._tag !== "ok") throw new Error("settings parse failed");
  return parsed.value;
}

function fakeProvider(name: "exa" | "parallel" | "brave", outcome: "ok" | "fail"): SearchProvider {
  return {
    name,
    transport: "mcp",
    search: () =>
      Promise.resolve(
        outcome === "ok"
          ? ok([
              {
                title: `${name} result`,
                url: "https://example.com/" as never,
                snippet: "a snippet",
              },
            ])
          : err({ _tag: "ProviderRequestFailed" } as const),
      ),
  };
}

describe("websearch parameter schema", () => {
  const tool = createWebSearchTool({
    settings: settingsWith({}),
    providers: [],
    outputStore: new TempFileToolOutputStore(),
    secrets: [],
  });

  function validate(args: unknown): unknown {
    return validateToolArguments(tool, {
      type: "toolCall",
      id: "t",
      name: tool.name,
      // SAFETY: these tests feed deliberately malformed arguments through Pi's validator.
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
    expect(validate({ query: "x", provider: "brave", maxResults: "3" })).toEqual({
      query: "x",
      provider: "brave",
      maxResults: 3,
    });
  });
});

describe("parseWebSearchParams", () => {
  const settings = settingsWith({});

  test("parses a minimal query with settings defaults", () => {
    expect(parseWebSearchParams({ query: " pi agent " }, settings)).toEqual(
      ok({ query: "pi agent", maxResults: 8 }),
    );
  });

  test("rejects empty queries", () => {
    expect(parseWebSearchParams({ query: "   " }, settings)).toEqual(
      err({ _tag: "InvalidToolInput", message: "query cannot be empty" }),
    );
  });

  test("clamps maxResults and keeps the provider override", () => {
    expect(
      parseWebSearchParams({ query: "x", maxResults: 100, provider: "parallel" }, settings),
    ).toEqual(ok({ query: "x", maxResults: 20, provider: "parallel" }));
  });
});

describe("websearch tool", () => {
  test("returns results from the first healthy provider", async () => {
    const tool = createWebSearchTool({
      settings: settingsWith({}),
      providers: [fakeProvider("exa", "fail"), fakeProvider("parallel", "ok")],
      outputStore: new TempFileToolOutputStore(),
      secrets: [],
    });
    const result = await tool.execute("t1", { query: "pi agent" });

    expect(result.details.provider).toBe("parallel");
    expect(result.details.attemptedProviders).toEqual(["exa", "parallel"]);
    expect(result.details.resultCount).toBe(1);
    expect(textOf(result)).toContain("parallel result");
  });

  test("provider override skips the rest of the chain", async () => {
    const tool = createWebSearchTool({
      settings: settingsWith({ BRAVE_API_KEY: "BSA_test" }),
      providers: [
        fakeProvider("exa", "fail"),
        fakeProvider("parallel", "fail"),
        fakeProvider("brave", "ok"),
      ],
      outputStore: new TempFileToolOutputStore(),
      secrets: ["BSA_test"],
    });
    const result = await tool.execute("t1", { query: "pi agent", provider: "brave" });
    expect(result.details.provider).toBe("brave");
    expect(result.details.attemptedProviders).toEqual(["brave"]);
  });

  test("throws a safe message when every provider fails", async () => {
    const tool = createWebSearchTool({
      settings: settingsWith({}),
      providers: [fakeProvider("exa", "fail"), fakeProvider("parallel", "fail")],
      outputStore: new TempFileToolOutputStore(),
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
        Promise.resolve(ok([{ title: "leak sekrit-key", url: "https://example.com/" as never }])),
    };
    const tool = createWebSearchTool({
      settings: settingsWith({}),
      providers: [leaky],
      outputStore: new TempFileToolOutputStore(),
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
    settings: settingsWith({}),
    providers: [fakeProvider("exa", "ok")],
    outputStore: new TempFileToolOutputStore(),
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

describe("renderSearchChainError", () => {
  test("renders unknown providers and aggregate failures", () => {
    expect(
      renderSearchChainError({ _tag: "UnknownProvider", provider: "brave", available: ["exa"] }),
    ).toContain("brave");
    expect(
      renderSearchChainError({ _tag: "AllProvidersFailed", attempts: ["exa: unavailable"] }),
    ).toContain("exa: unavailable");
  });
});
