import { describe, expect, test } from "vitest";
import {
  ExaApiFetchProvider,
  ExaApiSearchProvider,
  ExaMcpFetchProvider,
  ExaMcpSearchProvider,
  parseExaSearchText,
} from "../provider-exa";
import { err, ok } from "../result";
import type { SearchQuery } from "../types";
import { fakeMcpClient, fakeProviderHttp } from "./fakes";

const QUERY = "pi coding agent" as SearchQuery;

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
    expect(parseExaSearchText("").results).toEqual([]);
    expect(parseExaSearchText("No results found").results).toEqual([]);
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

  test("Source beats Author, and Author fills in when Source is a placeholder", () => {
    const source = (headers: string) =>
      parseExaSearchText(`Title: T\nURL: https://a.example\n${headers}\nText: x`).results[0]
        ?.source;
    expect(source("Author: Ada\nSource: Docs")).toBe("Docs");
    expect(source("Source: Docs\nAuthor: Ada")).toBe("Docs");
    expect(source("Author: Ada\nSource: n/a")).toBe("Ada");
    expect(source("Author: none\nSource: unknown")).toBeUndefined();
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

describe("ExaMcpSearchProvider", () => {
  test("sends the official web_search_exa contract and parses text results", async () => {
    const { client, calls } = fakeMcpClient([ok({ text: [EXA_TEXT] })]);
    const provider = new ExaMcpSearchProvider(client);
    const result = await provider.search({ query: QUERY, maxResults: 5 });

    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(result.value).toHaveLength(2);
    expect(calls[0]?.name).toBe("web_search_exa");
    expect(calls[0]?.args).toEqual({ query: QUERY, objective: QUERY, numResults: 5 });
  });

  test("passes MCP failures through", async () => {
    const { client } = fakeMcpClient([err({ _tag: "ProviderStatusRejected", status: 429 })]);
    const provider = new ExaMcpSearchProvider(client);
    const result = await provider.search({ query: QUERY, maxResults: 5 });
    expect(result).toEqual({
      _tag: "err",
      error: { _tag: "ProviderStatusRejected", status: 429 },
    });
  });
});

describe("ExaApiSearchProvider", () => {
  test("posts the official /search contract with the key header", async () => {
    const { client, requests } = fakeProviderHttp([
      ok({
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
    const provider = new ExaApiSearchProvider("test-key", client);
    const result = await provider.search({ query: QUERY, maxResults: 8 });

    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(result.value[0]?.title).toBe("Exa Docs");
    expect(result.value[0]?.snippet).toContain("search API");
    expect(result.value[0]?.publishedAt).toBe("2026-02-01");

    const request = requests[0];
    expect(request?.url).toBe("https://api.exa.ai/search");
    expect(request?.headers["x-api-key"]).toBe("test-key");
    expect(request?.body).toMatchObject({
      query: QUERY,
      type: "auto",
      numResults: 8,
      livecrawl: "fallback",
      contents: { highlights: true },
    });
  });

  test("passes HTTP failures through and rejects invalid payloads", async () => {
    const { client } = fakeProviderHttp([err({ _tag: "ProviderStatusRejected", status: 401 })]);
    const provider = new ExaApiSearchProvider("test-key", client);
    const result = await provider.search({ query: QUERY, maxResults: 8 });
    expect(result).toEqual({
      _tag: "err",
      error: { _tag: "ProviderStatusRejected", status: 401 },
    });

    const { client: badJson } = fakeProviderHttp([ok({ bodyText: "not json" })]);
    const badResult = await new ExaApiSearchProvider("k", badJson).search({
      query: QUERY,
      maxResults: 8,
    });
    expect(badResult).toEqual(
      err({ _tag: "ProviderProtocolInvalid", reason: "Invalid JSON response" }),
    );

    const { client: missing } = fakeProviderHttp([
      ok({ bodyText: JSON.stringify({}) }),
      ok({ bodyText: JSON.stringify({ results: { url: "https://a.example" } }) }),
    ]);
    const missingProvider = new ExaApiSearchProvider("k", missing);
    const missingResults = err({
      _tag: "ProviderProtocolInvalid",
      reason: "Missing results array",
    });
    expect(await missingProvider.search({ query: QUERY, maxResults: 8 })).toEqual(missingResults);
    expect(await missingProvider.search({ query: QUERY, maxResults: 8 })).toEqual(missingResults);
  });

  test("skips invalid items and falls back when a field has the wrong type", async () => {
    const { client } = fakeProviderHttp([
      ok({
        bodyText: JSON.stringify({
          results: [
            null,
            { title: "No URL" },
            { url: "notaurl" },
            {
              url: "https://a.example",
              title: 5,
              highlights: "not an array",
              publishedDate: 20260101,
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
    const result = await new ExaApiSearchProvider("k", client).search({
      query: QUERY,
      maxResults: 8,
    });

    expect(result).toEqual(
      ok([
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
  });

  test("caps results at maxResults", async () => {
    const results = ["a", "b", "c"].map((host) => ({ url: `https://${host}.example` }));
    const { client } = fakeProviderHttp([ok({ bodyText: JSON.stringify({ results }) })]);
    const result = await new ExaApiSearchProvider("k", client).search({
      query: QUERY,
      maxResults: 1,
    });

    expect(result._tag === "ok" && result.value.map((item) => item.url)).toEqual([
      "https://a.example/",
    ]);
  });
});

describe("ExaMcpFetchProvider", () => {
  test("calls web_fetch_exa with the urls contract", async () => {
    const { client, calls } = fakeMcpClient([ok({ text: ["# Page content"] })]);
    const provider = new ExaMcpFetchProvider(client);
    const result = await provider.fetchMarkdown("https://example.com" as never);

    expect(result).toBe("# Page content");
    expect(calls[0]?.name).toBe("web_fetch_exa");
    expect(calls[0]?.args.urls).toEqual(["https://example.com"]);
  });

  test("returns undefined for empty responses and MCP failures", async () => {
    const { client } = fakeMcpClient([ok({ text: [] })]);
    const empty = await new ExaMcpFetchProvider(client).fetchMarkdown(
      "https://example.com" as never,
    );
    expect(empty).toBeUndefined();

    const { client: failing } = fakeMcpClient([err({ _tag: "ProviderToolError" })]);
    const failed = await new ExaMcpFetchProvider(failing).fetchMarkdown(
      "https://example.com" as never,
    );
    expect(failed).toBeUndefined();
  });
});

describe("ExaApiFetchProvider", () => {
  test("posts to /contents and returns page text", async () => {
    const { client, requests } = fakeProviderHttp([
      ok({
        bodyText: JSON.stringify({ results: [{ url: "https://example.com", text: "page body" }] }),
      }),
    ]);
    const provider = new ExaApiFetchProvider("test-key", client);
    const result = await provider.fetchMarkdown("https://example.com" as never);

    expect(result).toBe("page body");
    expect(requests[0]?.url).toBe("https://api.exa.ai/contents");
    expect(requests[0]?.body).toMatchObject({
      urls: ["https://example.com"],
      livecrawl: "preferred",
    });
  });

  test("returns undefined for empty results, invalid JSON, and HTTP failures", async () => {
    const { client } = fakeProviderHttp([
      ok({ bodyText: JSON.stringify({ results: [] }) }),
      ok({ bodyText: "not json" }),
      err({ _tag: "ProviderTimedOut", timeoutSeconds: 25 }),
    ]);
    const provider = new ExaApiFetchProvider("k", client);
    const url = "https://example.com" as never;
    expect(await provider.fetchMarkdown(url)).toBeUndefined();
    expect(await provider.fetchMarkdown(url)).toBeUndefined();
    expect(await provider.fetchMarkdown(url)).toBeUndefined();
  });

  test("reads only the first result's trimmed text", async () => {
    const fetchBody = (body: unknown) => {
      const { client } = fakeProviderHttp([ok({ bodyText: JSON.stringify(body) })]);
      return new ExaApiFetchProvider("k", client).fetchMarkdown("https://example.com" as never);
    };

    expect(await fetchBody({ results: [{ text: "  page body  " }, { text: "second" }] })).toBe(
      "page body",
    );
    expect(await fetchBody({ results: [null, { text: "second" }] })).toBeUndefined();
    expect(await fetchBody({ results: [{ text: 5 }] })).toBeUndefined();
    expect(await fetchBody({ results: [{ text: "   " }] })).toBeUndefined();
    expect(await fetchBody({ results: "not an array" })).toBeUndefined();
  });
});
