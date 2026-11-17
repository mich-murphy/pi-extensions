import { Redacted, Result } from "effect";
import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";
import { HttpStatusRejected } from "../network";
import { BraveApiSearchProvider } from "../provider-brave";
import {
  ExaApiFetchProvider,
  ExaApiSearchProvider,
  ExaMcpFetchProvider,
  ExaMcpSearchProvider,
} from "../provider-exa";
import {
  ParallelApiSearchProvider,
  ParallelMcpFetchProvider,
  ParallelMcpSearchProvider,
} from "../provider-parallel";
import type { FetchProvider, SearchProvider } from "../provider-types";
import { WEB_SEARCH_OUTPUT_SCHEMA } from "../tool-output";
import { createWebFetchTool } from "../webfetch";
import { createWebSearchTool } from "../websearch";
import {
  fakeMcpClient,
  fakeProviderHttp,
  fakePublicWeb,
  fetchPageWith,
  redactorFor,
  settingsFrom,
  textOf,
  toolRuntimeWith,
} from "./fakes";

const SECRET = "sekrit-key";
const SETTINGS = settingsFrom({ EXA_API_KEY: SECRET });
const KEY = Redacted.make("adapter-key");

function json(payload: unknown) {
  return Result.succeed({ bodyText: JSON.stringify(payload) });
}

type SearchCase = {
  readonly name: string;
  readonly make: (leak: string) => SearchProvider;
  readonly expected: (leak: string) => Record<string, unknown>;
};

const SEARCH_CASES: readonly SearchCase[] = [
  {
    name: "Brave API",
    make: (leak) =>
      new BraveApiSearchProvider(
        KEY,
        fakeProviderHttp([
          json({
            web: {
              results: [
                {
                  title: "Brave Page",
                  url: "https://brave.example/page",
                  description: `Snippet ${leak}`,
                  page_age: "2026-01-15",
                },
                { title: "Broken", url: "notaurl" },
              ],
            },
          }),
        ]).client,
      ),
    expected: (leak) => ({
      title: "Brave Page",
      url: "https://brave.example/page",
      snippet: `Snippet ${leak}`,
      published_at: "2026-01-15",
      source: "Brave",
    }),
  },
  {
    name: "Parallel API",
    make: (leak) =>
      new ParallelApiSearchProvider(
        KEY,
        fakeProviderHttp([
          json({
            results: [
              {
                title: "Parallel Page",
                url: "https://parallel.example/page",
                publish_date: "2026-03-01",
                excerpts: [`Snippet ${leak}`, "More"],
              },
              { url: "notaurl" },
            ],
          }),
        ]).client,
      ),
    expected: (leak) => ({
      title: "Parallel Page",
      url: "https://parallel.example/page",
      snippet: `Snippet ${leak}\n\nMore`,
      published_at: "2026-03-01",
      source: "Parallel",
    }),
  },
  {
    name: "Parallel MCP",
    make: (leak) =>
      new ParallelMcpSearchProvider(
        fakeMcpClient([
          Result.succeed({
            text: [],
            structuredContent: {
              results: [
                {
                  title: "Parallel Page",
                  url: "https://parallel.example/page",
                  publish_date: "2026-03-01",
                  excerpts: [`Snippet ${leak}`, "More"],
                },
                { url: "notaurl" },
              ],
            },
          }),
        ]).client,
        "session",
      ),
    expected: (leak) => ({
      title: "Parallel Page",
      url: "https://parallel.example/page",
      snippet: `Snippet ${leak}\n\nMore`,
      published_at: "2026-03-01",
      source: "Parallel",
    }),
  },
  {
    name: "Exa API",
    make: (leak) =>
      new ExaApiSearchProvider(
        KEY,
        fakeProviderHttp([
          json({
            results: [
              {
                title: "Exa Page",
                url: "https://exa.example/page",
                highlights: [`Snippet ${leak}`],
                publishedDate: "2026-02-02",
                author: "Ann",
                score: 0.75,
              },
              { url: "notaurl" },
            ],
          }),
        ]).client,
      ),
    expected: (leak) => ({
      title: "Exa Page",
      url: "https://exa.example/page",
      snippet: `Snippet ${leak}`,
      published_at: "2026-02-02",
      source: "Ann",
      score: 0.75,
    }),
  },
  {
    name: "Exa MCP",
    make: (leak) =>
      new ExaMcpSearchProvider(
        fakeMcpClient([
          Result.succeed({
            text: [
              `Title: Exa Page\nURL: https://exa.example/page\nPublished Date: 2026-02-02\nAuthor: Ann\nScore: 0.75\nText: Snippet ${leak}\n\nTitle: Broken\nURL: notaurl\nText: bad`,
            ],
          }),
        ]).client,
      ),
    expected: (leak) => ({
      title: "Exa Page",
      url: "https://exa.example/page",
      snippet: `Snippet ${leak}`,
      published_at: "2026-02-02",
      source: "Ann",
      score: 0.75,
    }),
  },
];

function searchTool(...providers: readonly SearchProvider[]) {
  return createWebSearchTool({
    settings: SETTINGS,
    redactText: redactorFor(SECRET),
    runtime: toolRuntimeWith({ settings: SETTINGS, secret: SECRET, searchProviders: providers }),
  });
}

describe("websearch structuredContent through real adapters", () => {
  test.each(SEARCH_CASES)(
    "$name redacts a configured key found in a response",
    async (testCase) => {
      const result = await searchTool(testCase.make(SECRET)).execute("t", {
        query: `find ${SECRET}`,
      });

      expect(Value.Check(WEB_SEARCH_OUTPUT_SCHEMA, result.structuredContent)).toBe(true);
      expect(JSON.stringify(result.structuredContent)).not.toContain(SECRET);
      expect(textOf(result)).not.toContain(SECRET);
      expect(result.structuredContent).toMatchObject({
        query: "find [redacted]",
        results: [testCase.expected("[redacted]")],
      });
    },
  );
});

type RescueCase = {
  readonly name: string;
  readonly make: (markdown: string) => FetchProvider;
};

const RESCUE_CASES: readonly RescueCase[] = [
  {
    name: "Exa MCP",
    make: (markdown) =>
      new ExaMcpFetchProvider(fakeMcpClient([Result.succeed({ text: [markdown] })]).client),
  },
  {
    name: "Exa API",
    make: (markdown) =>
      new ExaApiFetchProvider(
        KEY,
        fakeProviderHttp([json({ results: [{ url: "https://blocked.example/", text: markdown }] })])
          .client,
      ),
  },
  {
    name: "Parallel MCP",
    make: (markdown) =>
      new ParallelMcpFetchProvider(
        fakeMcpClient([
          Result.succeed({
            text: [],
            structuredContent: {
              results: [{ url: "https://blocked.example/", content: markdown }],
            },
          }),
        ]).client,
        "session",
      ),
  },
];

function rescueTool(provider: FetchProvider) {
  return createWebFetchTool({
    settings: SETTINGS,
    redactText: redactorFor(SECRET),
    runtime: toolRuntimeWith({
      settings: SETTINGS,
      secret: SECRET,
      fetchPage: fetchPageWith(
        fakePublicWeb(Result.fail(new HttpStatusRejected({ status: 403, statusText: "Forbidden" })))
          .client,
      ),
      fetchProviders: [provider],
    }),
  });
}

const BLOCKED = { url: "https://blocked.example/" };

describe("webfetch structuredContent through real rescue adapters", () => {
  test.each(RESCUE_CASES)("$name redacts secrets in rescued markdown", async (testCase) => {
    const result = await rescueTool(testCase.make(`leaked ${SECRET}`)).execute("t", BLOCKED);

    expect(JSON.stringify(result.structuredContent)).not.toContain(SECRET);
    expect(textOf(result)).not.toContain(SECRET);
    expect(result.structuredContent).toMatchObject({ content: "leaked [redacted]" });
  });
});
