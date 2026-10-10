import { assert, describe, expect, it, test } from "@effect/vitest";
import { Effect, Redacted, Result } from "effect";
import {
  ExaApiFetchProvider,
  ExaApiSearchProvider,
  ExaMcpFetchProvider,
  ExaMcpSearchProvider,
  parseExaSearchText,
} from "../provider-exa";
import {
  ProviderProtocolInvalid,
  ProviderStatusRejected,
  ProviderTimedOut,
  ProviderToolError,
} from "../provider-types";
import { fakeMcpClient, fakeProviderHttp, publicUrl, searchQuery } from "./fakes";

const QUERY = searchQuery("pi coding agent");
const PAGE = publicUrl("https://example.com/");

function sourceOf(headers: string) {
  return parseExaSearchText(`Title: T\nURL: https://a.example\n${headers}\nText: x`).results[0]
    ?.source;
}

function fetchBody(body: unknown) {
  const { client } = fakeProviderHttp([Result.succeed({ bodyText: JSON.stringify(body) })]);
  return new ExaApiFetchProvider(Redacted.make("k"), client).fetchMarkdown(PAGE);
}

const EXA_TEXT = `Title: Pi Coding Agent
URL: https://pi.dev
Published Date: 2026-01-01
Author: Mario
Score: 0.95
Text: Pi is a minimal coding agent.
It supports extensions.

Title: GitHub - badlogic/pi-mono
URL: https://github.com/badlogic/pi-mono
Text: Source for the pi agent toolkit.`;

describe("parseExaSearchText", () => {
  test("parses titled sections with metadata", () => {
    const parsed = parseExaSearchText(EXA_TEXT);
    expect(parsed.results).toHaveLength(2);
    const [first, second] = parsed.results;
    expect(first?.title).toBe("Pi Coding Agent");
    expect(first?.url).toBe("https://pi.dev/");
    expect(first?.publishedAt).toBe("2026-01-01");
    expect(first?.source).toBe("Mario");
    expect(first?.score).toBe(0.95);
    expect(first?.snippet).toContain("minimal coding agent");
    expect(second?.title).toContain("pi-mono");
    expect(parsed.discardedSections).toBe(0);
  });

  test("handles empty and no-results responses", () => {
    expect(parseExaSearchText("").results).toStrictEqual([]);
    expect(parseExaSearchText("No results found").results).toStrictEqual([]);
  });

  test("discards sections without valid URLs", () => {
    const parsed = parseExaSearchText(
      "Title: Broken\nURL: notaurl\nText: x\n\nTitle: Good\nURL: https://ok.example\nText: y",
    );
    expect(parsed.results).toHaveLength(1);
    expect(parsed.discardedSections).toBe(1);
  });

  test("the last usable header line wins; placeholders and bad scores never clear a value", () => {
    const [result] = parseExaSearchText(
      [
        // A Title: line after a URL: line starts a new section, so repeated titles come first.
        "Title: First",
        "Title: Second",
        "URL: https://first.example",
        "URL: https://second.example",
        "Published: 2026-01-01",
        "Published Date: 2026-02-02",
        "Published: n/a",
        "Score: 0.5",
        "Score: high",
        "Text: body",
      ].join("\n"),
    ).results;
    expect(result?.title).toBe("Second");
    expect(result?.url).toBe("https://second.example/");
    // Published Date: and Published: are aliases; n/a does not erase the earlier date.
    expect(result?.publishedAt).toBe("2026-02-02");
    expect(result?.score).toBe(0.5);
  });

  test("source beats Author, and Author fills in when Source is a placeholder", () => {
    expect(sourceOf("Author: Ada\nSource: Docs")).toBe("Docs");
    expect(sourceOf("Source: Docs\nAuthor: Ada")).toBe("Docs");
    expect(sourceOf("Author: Ada\nSource: n/a")).toBe("Ada");
    expect(sourceOf("Author: none\nSource: unknown")).toBeUndefined();
  });

  test("header prefixes after the first Text: line are snippet text, not metadata", () => {
    const [result] = parseExaSearchText(
      "Title: Page\nURL: https://a.example\nText: intro\nAuthor: Quoted\nScore: 9",
    ).results;
    expect(result?.source).toBeUndefined();
    expect(result?.score).toBeUndefined();
    expect(result?.snippet).toBe("intro\nAuthor: Quoted\nScore: 9");
  });

  test("strips repeated leading titles and blank lines from the snippet", () => {
    const [result] = parseExaSearchText(
      "Title: Pi Agent\nURL: https://a.example\nText: Pi Agent\n\npi agent\nActual body.\nPi Agent",
    ).results;
    expect(result?.snippet).toBe("Actual body.\nPi Agent");

    const [titleOnly] = parseExaSearchText(
      "Title: Pi Agent\nURL: https://a.example\nText: Pi Agent",
    ).results;
    // Nothing but the title is left, so the snippet keeps the collapsed text.
    expect(titleOnly?.snippet).toBe("Pi Agent");
  });
});

describe("exaMcpSearchProvider", () => {
  it.effect("sends the official web_search_exa contract and parses text results", () =>
    Effect.gen(function* () {
      const { client, calls } = fakeMcpClient([Result.succeed({ text: [EXA_TEXT] })]);
      const provider = new ExaMcpSearchProvider(client);
      const result = yield* Effect.result(provider.search({ query: QUERY, maxResults: 5 }));

      assert(Result.isSuccess(result));
      expect(result.success).toHaveLength(2);
      expect(calls[0]?.name).toBe("web_search_exa");
      expect(calls[0]?.args).toStrictEqual({ query: QUERY, objective: QUERY, numResults: 5 });
    }),
  );

  it.effect("passes MCP failures through", () =>
    Effect.gen(function* () {
      const { client } = fakeMcpClient([Result.fail(new ProviderStatusRejected({ status: 429 }))]);
      const provider = new ExaMcpSearchProvider(client);
      const result = yield* Effect.result(provider.search({ query: QUERY, maxResults: 5 }));
      expect(result).toStrictEqual(Result.fail(new ProviderStatusRejected({ status: 429 })));
    }),
  );
});

describe("exaApiSearchProvider", () => {
  it.effect("posts the official /search contract with the key header", () =>
    Effect.gen(function* () {
      const { client, requests } = fakeProviderHttp([
        Result.succeed({
          bodyText: JSON.stringify({
            results: [
              {
                title: "Exa Docs",
                url: "https://docs.exa.ai",
                publishedDate: "2026-02-01",
                author: "Exa",
                score: 0.9,
                highlights: ["Exa is a search API.", "Built for AI."],
              },
            ],
          }),
        }),
      ]);
      const provider = new ExaApiSearchProvider(Redacted.make("test-key"), client);
      const result = yield* Effect.result(provider.search({ query: QUERY, maxResults: 8 }));

      assert(Result.isSuccess(result));
      expect(result.success[0]?.title).toBe("Exa Docs");
      expect(result.success[0]?.snippet).toContain("search API");
      expect(result.success[0]?.publishedAt).toBe("2026-02-01");

      const [request] = requests;
      assert(request !== undefined);
      expect(request.url).toBe("https://api.exa.ai/search");
      expect(request.headers["x-api-key"]).toBe("test-key");
      expect(request.body).toMatchObject({
        query: QUERY,
        type: "auto",
        numResults: 8,
        livecrawl: "fallback",
        contents: { highlights: true },
      });
    }),
  );

  it.effect("passes HTTP failures through and rejects invalid payloads", () =>
    Effect.gen(function* () {
      const { client } = fakeProviderHttp([
        Result.fail(new ProviderStatusRejected({ status: 401 })),
      ]);
      const provider = new ExaApiSearchProvider(Redacted.make("test-key"), client);
      const result = yield* Effect.result(provider.search({ query: QUERY, maxResults: 8 }));
      expect(result).toStrictEqual(Result.fail(new ProviderStatusRejected({ status: 401 })));

      const { client: badJson } = fakeProviderHttp([Result.succeed({ bodyText: "not json" })]);
      const badResult = yield* Effect.result(
        new ExaApiSearchProvider(Redacted.make("k"), badJson).search({
          query: QUERY,
          maxResults: 8,
        }),
      );
      expect(badResult).toStrictEqual(
        Result.fail(new ProviderProtocolInvalid({ reason: "Invalid JSON response" })),
      );

      const { client: missing } = fakeProviderHttp([
        Result.succeed({ bodyText: JSON.stringify({}) }),
        Result.succeed({ bodyText: JSON.stringify({ results: { url: "https://a.example" } }) }),
      ]);
      const missingProvider = new ExaApiSearchProvider(Redacted.make("k"), missing);
      const missingResults = Result.fail(
        new ProviderProtocolInvalid({ reason: "Missing results array" }),
      );
      expect(
        yield* Effect.result(missingProvider.search({ query: QUERY, maxResults: 8 })),
      ).toStrictEqual(missingResults);
      expect(
        yield* Effect.result(missingProvider.search({ query: QUERY, maxResults: 8 })),
      ).toStrictEqual(missingResults);
    }),
  );

  it.effect("skips invalid items and falls back when a field has the wrong type", () =>
    Effect.gen(function* () {
      const { client } = fakeProviderHttp([
        Result.succeed({
          bodyText: JSON.stringify({
            results: [
              null,
              { title: "No URL" },
              { url: "notaurl" },
              {
                url: "https://a.example",
                title: 5,
                highlights: "not an array",
                publishedDate: 20_260_101,
                author: {},
                score: "0.9",
              },
              {
                url: "https://b.example",
                title: " B ",
                highlights: ["B", 3, "Body text."],
                publishedDate: "2026-01-01",
                author: "Ada",
                score: 0.5,
              },
            ],
          }),
        }),
      ]);
      const result = yield* Effect.result(
        new ExaApiSearchProvider(Redacted.make("k"), client).search({
          query: QUERY,
          maxResults: 8,
        }),
      );

      expect(result).toStrictEqual(
        Result.succeed([
          {
            title: "https://a.example/",
            url: "https://a.example/",
            snippet: undefined,
            publishedAt: undefined,
            source: undefined,
            score: undefined,
          },
          {
            title: "B",
            url: "https://b.example/",
            // Non-string highlights are dropped and the repeated leading title is stripped.
            snippet: "Body text.",
            publishedAt: "2026-01-01",
            source: "Ada",
            score: 0.5,
          },
        ]),
      );
    }),
  );

  it.effect("caps results at maxResults", () =>
    Effect.gen(function* () {
      const results = ["a", "b", "c"].map((host) => ({ url: `https://${host}.example` }));
      const { client } = fakeProviderHttp([
        Result.succeed({ bodyText: JSON.stringify({ results }) }),
      ]);
      const result = yield* Effect.result(
        new ExaApiSearchProvider(Redacted.make("k"), client).search({
          query: QUERY,
          maxResults: 1,
        }),
      );

      assert(Result.isSuccess(result));
      expect(result.success.map((item) => item.url)).toStrictEqual(["https://a.example/"]);
    }),
  );
});

describe("exaMcpFetchProvider", () => {
  it.effect("calls web_fetch_exa with the urls contract", () =>
    Effect.gen(function* () {
      const { client, calls } = fakeMcpClient([Result.succeed({ text: ["# Page content"] })]);
      const provider = new ExaMcpFetchProvider(client);
      const result = yield* provider.fetchMarkdown(PAGE);

      expect(result).toBe("# Page content");
      expect(calls[0]?.name).toBe("web_fetch_exa");
      expect(calls[0]?.args.urls).toStrictEqual([PAGE]);
    }),
  );

  it.effect("returns undefined for empty responses and MCP failures", () =>
    Effect.gen(function* () {
      const { client } = fakeMcpClient([Result.succeed({ text: [] })]);
      const empty = yield* new ExaMcpFetchProvider(client).fetchMarkdown(PAGE);
      expect(empty).toBeUndefined();

      const { client: failing } = fakeMcpClient([
        Result.fail(new ProviderToolError({ detail: "boom" })),
      ]);
      const failed = yield* new ExaMcpFetchProvider(failing).fetchMarkdown(PAGE);
      expect(failed).toBeUndefined();
    }),
  );
});

describe("exaApiFetchProvider", () => {
  it.effect("posts to /contents and returns page text", () =>
    Effect.gen(function* () {
      const { client, requests } = fakeProviderHttp([
        Result.succeed({
          bodyText: JSON.stringify({
            results: [{ url: "https://example.com", text: "page body" }],
          }),
        }),
      ]);
      const provider = new ExaApiFetchProvider(Redacted.make("test-key"), client);
      const result = yield* provider.fetchMarkdown(PAGE);

      expect(result).toBe("page body");
      expect(requests[0]?.url).toBe("https://api.exa.ai/contents");
      expect(requests[0]?.body).toMatchObject({
        urls: [PAGE],
        livecrawl: "preferred",
      });
    }),
  );

  it.effect("returns undefined for empty results, invalid JSON, and HTTP failures", () =>
    Effect.gen(function* () {
      const { client } = fakeProviderHttp([
        Result.succeed({ bodyText: JSON.stringify({ results: [] }) }),
        Result.succeed({ bodyText: "not json" }),
        Result.fail(new ProviderTimedOut({ timeoutSeconds: 25 })),
      ]);
      const provider = new ExaApiFetchProvider(Redacted.make("k"), client);
      expect(yield* provider.fetchMarkdown(PAGE)).toBeUndefined();
      expect(yield* provider.fetchMarkdown(PAGE)).toBeUndefined();
      expect(yield* provider.fetchMarkdown(PAGE)).toBeUndefined();
    }),
  );

  it.effect("reads only the first result's trimmed text", () =>
    Effect.gen(function* () {
      expect(yield* fetchBody({ results: [{ text: "  page body  " }, { text: "second" }] })).toBe(
        "page body",
      );
      expect(yield* fetchBody({ results: [null, { text: "second" }] })).toBeUndefined();
      expect(yield* fetchBody({ results: [{ text: 5 }] })).toBeUndefined();
      expect(yield* fetchBody({ results: [{ text: "   " }] })).toBeUndefined();
      expect(yield* fetchBody({ results: "not an array" })).toBeUndefined();
    }),
  );
});
