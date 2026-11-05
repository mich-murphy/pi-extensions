import { Redacted, Result } from "effect";
import { Value } from "typebox/value";
import { assert, describe, expect, test } from "vitest";
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
import { ProviderStatusRejected } from "../provider-types";
import type { FetchProvider, SearchProvider } from "../provider-types";
import {
  STRUCTURED_OUTPUT_MAX_BYTES,
  WEB_FETCH_OUTPUT_SCHEMA,
  WEB_SEARCH_OUTPUT_SCHEMA,
} from "../tool-output";
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
  readonly provider: "brave" | "parallel" | "exa";
  readonly make: (leak: string) => SearchProvider;
  readonly expected: (leak: string) => Record<string, unknown>;
};

const SEARCH_CASES: readonly SearchCase[] = [
  {
    name: "Brave API",
    provider: "brave",
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
    provider: "parallel",
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
    provider: "parallel",
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
    provider: "exa",
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
    provider: "exa",
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
    "$name maps results, skips invalid items and names the provider",
    async (testCase) => {
      const result = await searchTool(testCase.make("plain")).execute("t", { query: "pi agent" });

      expect(Value.Check(WEB_SEARCH_OUTPUT_SCHEMA, result.structuredContent)).toBe(true);
      expect(result.structuredContent).toMatchObject({
        query: "pi agent",
        provider: testCase.provider,
        results: [testCase.expected("plain")],
      });
      expect(result.structuredContent).toHaveProperty("results.length", 1);
    },
  );

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

  test("names the provider that answered after an earlier one failed", async () => {
    const failing = new ExaMcpSearchProvider(
      fakeMcpClient([Result.fail(new ProviderStatusRejected({ status: 429 }))]).client,
    );
    const braveCase = SEARCH_CASES[0];
    assert(braveCase !== undefined);
    const result = await searchTool(failing, braveCase.make("plain")).execute("t", {
      query: "pi agent",
    });

    expect(Value.Check(WEB_SEARCH_OUTPUT_SCHEMA, result.structuredContent)).toBe(true);
    expect(result.structuredContent).toMatchObject({ provider: "brave" });
    expect(result.details.attemptedProviders).toStrictEqual(["exa", "brave"]);
  });
});

type RescueCase = {
  readonly name: string;
  readonly provider: "exa" | "parallel";
  readonly make: (markdown: string) => FetchProvider;
};

const RESCUE_CASES: readonly RescueCase[] = [
  {
    name: "Exa MCP",
    provider: "exa",
    make: (markdown) =>
      new ExaMcpFetchProvider(fakeMcpClient([Result.succeed({ text: [markdown] })]).client),
  },
  {
    name: "Exa API",
    provider: "exa",
    make: (markdown) =>
      new ExaApiFetchProvider(
        KEY,
        fakeProviderHttp([json({ results: [{ url: "https://blocked.example/", text: markdown }] })])
          .client,
      ),
  },
  {
    name: "Parallel MCP",
    provider: "parallel",
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
  test.each(RESCUE_CASES)("$name supplies the page and is named in via", async (testCase) => {
    const result = await rescueTool(testCase.make("# Rescued\n\nbody")).execute("t", BLOCKED);

    expect(Value.Check(WEB_FETCH_OUTPUT_SCHEMA, result.structuredContent)).toBe(true);
    expect(result.structuredContent).toStrictEqual({
      url: "https://blocked.example/",
      format: "markdown",
      bytes: 15,
      content: "# Rescued\n\nbody",
      truncated: false,
      via: testCase.provider,
    });
    expect(result.structuredContent).not.toHaveProperty("status");
    expect(result.structuredContent).not.toHaveProperty("mime_type");
  });

  test.each(RESCUE_CASES)("$name redacts secrets in rescued markdown", async (testCase) => {
    const result = await rescueTool(testCase.make(`leaked ${SECRET}`)).execute("t", BLOCKED);

    expect(JSON.stringify(result.structuredContent)).not.toContain(SECRET);
    expect(textOf(result)).not.toContain(SECRET);
    expect(result.structuredContent).toMatchObject({ content: "leaked [redacted]" });
  });

  test.each(RESCUE_CASES)(
    "$name keeps a single-line body over 50 KB whole and spills it",
    async (testCase) => {
      const body = "x".repeat(200_000);
      assert(Buffer.byteLength(body) < STRUCTURED_OUTPUT_MAX_BYTES);
      const result = await rescueTool(testCase.make(body)).execute("t", BLOCKED);

      expect(Value.Check(WEB_FETCH_OUTPUT_SCHEMA, result.structuredContent)).toBe(true);
      expect(result.structuredContent).toMatchObject({
        content: body,
        truncated: false,
        full_output_path: result.details.fullOutputPath,
      });
      expect(result.details.fullOutputPath).toBeTypeOf("string");
    },
  );
});

const LINE_BYTES = 100;
const PAGED_BODY = Array.from(
  { length: 10_600 },
  (_, index) => `${String(index).padStart(8, "0")}${"x".repeat(LINE_BYTES - 9)}`,
).join("\n");

function pagedWindow(structured: unknown) {
  assert(typeof structured === "object" && structured !== null);
  assert("content" in structured && typeof structured.content === "string");
  return structured;
}

describe("webfetch paging through real rescue adapters", () => {
  test.each(RESCUE_CASES)(
    "$name pages rescued markdown by the offset the notice names",
    async (testCase) => {
      const first = await rescueTool(testCase.make(PAGED_BODY)).execute("t", BLOCKED);
      const next = Number(/offset=(?<next>\d+) to continue/u.exec(textOf(first))?.groups?.next);
      expect(next).toBeGreaterThan(0);
      expect(next).toBeLessThan(STRUCTURED_OUTPUT_MAX_BYTES);

      const second = await rescueTool(testCase.make(PAGED_BODY)).execute("t", {
        ...BLOCKED,
        offset: next,
      });
      expect(Value.Check(WEB_FETCH_OUTPUT_SCHEMA, second.structuredContent)).toBe(true);
      expect(pagedWindow(second.structuredContent)).toMatchObject({
        content: PAGED_BODY.slice(next),
        offset: next,
        truncated: false,
        via: testCase.provider,
      });
      expect(second.structuredContent).not.toHaveProperty("next_offset");
      expect(textOf(second)).toContain(PAGED_BODY.slice(next, next + 200));
    },
  );

  test.each(RESCUE_CASES)(
    "$name advances next_offset and drops it at the end",
    async (testCase) => {
      const first = await rescueTool(testCase.make(PAGED_BODY)).execute("t", BLOCKED);
      expect(Value.Check(WEB_FETCH_OUTPUT_SCHEMA, first.structuredContent)).toBe(true);
      expect(first.structuredContent).toMatchObject({
        content: PAGED_BODY.slice(0, STRUCTURED_OUTPUT_MAX_BYTES),
        truncated: true,
        next_offset: STRUCTURED_OUTPUT_MAX_BYTES,
      });
      expect(first.structuredContent).not.toHaveProperty("offset");

      const last = await rescueTool(testCase.make(PAGED_BODY)).execute("t", {
        ...BLOCKED,
        offset: STRUCTURED_OUTPUT_MAX_BYTES,
      });
      expect(Value.Check(WEB_FETCH_OUTPUT_SCHEMA, last.structuredContent)).toBe(true);
      expect(last.structuredContent).toMatchObject({
        content: PAGED_BODY.slice(STRUCTURED_OUTPUT_MAX_BYTES),
        offset: STRUCTURED_OUTPUT_MAX_BYTES,
        truncated: false,
      });
      expect(last.structuredContent).not.toHaveProperty("next_offset");
    },
  );

  test.each(RESCUE_CASES)("$name reports an offset past the end as empty", async (testCase) => {
    const offset = PAGED_BODY.length + 10;
    const result = await rescueTool(testCase.make(PAGED_BODY)).execute("t", {
      ...BLOCKED,
      offset,
    });

    expect(Value.Check(WEB_FETCH_OUTPUT_SCHEMA, result.structuredContent)).toBe(true);
    expect(textOf(result)).toContain(
      `[offset ${offset} is at or past the end of the content (${PAGED_BODY.length})`,
    );
    expect(result.structuredContent).toMatchObject({
      content: "",
      offset,
      truncated: false,
      via: testCase.provider,
    });
    expect(result.structuredContent).not.toHaveProperty("next_offset");
  });
});
