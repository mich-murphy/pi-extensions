import { assert, describe, expect, it, test } from "@effect/vitest";
import { Effect, Redacted, Result } from "effect";
import type { McpToolCallResult } from "../mcp";
import {
  ParallelApiSearchProvider,
  ParallelMcpFetchProvider,
  ParallelMcpSearchProvider,
  parseParallelMcpPayload,
  parseParallelResults,
} from "../provider-parallel";
import { ProviderProtocolInvalid, ProviderTimedOut } from "../provider-types";
import { fakeMcpClient, fakeProviderHttp, publicUrl, searchQuery } from "./fakes";

const QUERY = searchQuery("web search apis");
const PAGE = publicUrl("https://example.com/");

function fetchWith(result: McpToolCallResult) {
  const { client } = fakeMcpClient([Result.succeed(result)]);
  return new ParallelMcpFetchProvider(client, "s").fetchMarkdown(PAGE);
}

const RESULTS_PAYLOAD = {
  results: [
    {
      url: "https://parallel.ai",
      title: "Parallel Search",
      publish_date: "2026-03-01",
      excerpts: ["Web search for agents.", "LLM-optimized excerpts."],
    },
    { url: "notaurl", title: "broken" },
  ],
};

describe("parseParallelResults", () => {
  test("normalizes structured results and skips invalid URLs", () => {
    const parsed = parseParallelResults(RESULTS_PAYLOAD);
    assert(Result.isSuccess(parsed));
    expect(parsed.success).toHaveLength(1);
    expect(parsed.success[0]?.title).toBe("Parallel Search");
    expect(parsed.success[0]?.snippet).toContain("Web search for agents");
    expect(parsed.success[0]?.publishedAt).toBe("2026-03-01");
  });

  test("rejects payloads without a results array", () => {
    expect(parseParallelResults({})._tag).toBe("Failure");
    expect(parseParallelResults(null)._tag).toBe("Failure");
    expect(parseParallelResults({ results: "nope" })).toStrictEqual(
      Result.fail("Missing results array"),
    );
  });

  test("skips invalid items and falls back when a field has the wrong type", () => {
    const parsed = parseParallelResults({
      results: [
        null,
        "not an object",
        { url: 1 },
        { url: "https://a.example", title: ["x"], publish_date: 5, excerpts: "nope" },
        {
          url: "https://b.example",
          title: " B ",
          publish_date: " 2026-03-01 ",
          excerpts: ["one", 2, " two "],
        },
      ],
    });

    expect(parsed).toStrictEqual(
      Result.succeed([
        {
          title: "https://a.example/",
          url: "https://a.example/",
          snippet: undefined,
          publishedAt: undefined,
          source: "Parallel",
        },
        {
          title: "B",
          url: "https://b.example/",
          snippet: "one\n\n two",
          publishedAt: "2026-03-01",
          source: "Parallel",
        },
      ]),
    );
  });
});

describe("parseParallelMcpPayload", () => {
  test("falls back to JSON text when there is no structuredContent", () => {
    expect(parseParallelMcpPayload({ text: [JSON.stringify(RESULTS_PAYLOAD)] })).toStrictEqual(
      parseParallelResults(RESULTS_PAYLOAD),
    );
  });

  test("keeps a distinct reason for each missing or malformed payload", () => {
    expect(parseParallelMcpPayload({ text: [] })).toStrictEqual(
      Result.fail("Missing structured search results"),
    );
    expect(parseParallelMcpPayload({ text: ["not json"] })).toStrictEqual(
      Result.fail("Invalid structured search results"),
    );
    // A present structuredContent wins over text, even when it is not a results payload.
    expect(
      parseParallelMcpPayload({ text: [JSON.stringify(RESULTS_PAYLOAD)], structuredContent: null }),
    ).toStrictEqual(Result.fail("Missing results array"));
  });
});

describe("parallelMcpSearchProvider", () => {
  it.effect("sends the official web_search contract including session_id", () =>
    Effect.gen(function* () {
      const { client, calls } = fakeMcpClient([
        Result.succeed({ text: [], structuredContent: RESULTS_PAYLOAD }),
      ]);
      const provider = new ParallelMcpSearchProvider(client, "session-abc");
      const result = yield* Effect.result(provider.search({ query: QUERY, maxResults: 5 }));

      assert(Result.isSuccess(result));
      expect(result.success).toHaveLength(1);
      expect(calls[0]?.name).toBe("web_search");
      expect(calls[0]?.args).toStrictEqual({
        objective: QUERY,
        search_queries: [QUERY],
        session_id: "session-abc",
      });
    }),
  );

  it.effect("maps unparseable results to ProviderProtocolInvalid and caps maxResults", () =>
    Effect.gen(function* () {
      const { client } = fakeMcpClient([
        Result.succeed({ text: ["not json"] }),
        Result.succeed({
          text: [],
          structuredContent: { results: [...RESULTS_PAYLOAD.results, ...RESULTS_PAYLOAD.results] },
        }),
      ]);
      const provider = new ParallelMcpSearchProvider(client, "s");

      expect(yield* Effect.result(provider.search({ query: QUERY, maxResults: 5 }))).toStrictEqual(
        Result.fail(new ProviderProtocolInvalid({ reason: "Invalid structured search results" })),
      );
      const capped = yield* Effect.result(provider.search({ query: QUERY, maxResults: 1 }));
      assert(Result.isSuccess(capped));
      expect(capped.success).toHaveLength(1);
    }),
  );
});

describe("parallelApiSearchProvider", () => {
  it.effect("posts the official /v1/search contract", () =>
    Effect.gen(function* () {
      const { client, requests } = fakeProviderHttp([
        Result.succeed({ bodyText: JSON.stringify(RESULTS_PAYLOAD) }),
      ]);
      const provider = new ParallelApiSearchProvider(Redacted.make("test-key"), client);
      const result = yield* Effect.result(provider.search({ query: QUERY, maxResults: 6 }));

      expect(result._tag).toBe("Success");
      const [request] = requests;
      assert(request !== undefined);
      expect(request.url).toBe("https://api.parallel.ai/v1/search");
      expect(request.headers["x-api-key"]).toBe("test-key");
      expect(request.body).toMatchObject({
        objective: QUERY,
        search_queries: [QUERY],
        max_results: 6,
        mode: "fast",
      });
    }),
  );

  it.effect("propagates HTTP failures so the chain can fall through", () =>
    Effect.gen(function* () {
      const { client } = fakeProviderHttp([
        Result.fail(new ProviderTimedOut({ timeoutSeconds: 25 })),
      ]);
      const result = yield* Effect.result(
        new ParallelApiSearchProvider(Redacted.make("k"), client).search({
          query: QUERY,
          maxResults: 5,
        }),
      );
      expect(result).toStrictEqual(Result.fail(new ProviderTimedOut({ timeoutSeconds: 25 })));
    }),
  );

  it.effect("reports protocol failures with their reasons", () =>
    Effect.gen(function* () {
      const { client } = fakeProviderHttp([
        Result.succeed({ bodyText: "not json" }),
        Result.succeed({ bodyText: JSON.stringify({ results: {} }) }),
      ]);
      const provider = new ParallelApiSearchProvider(Redacted.make("k"), client);

      expect(yield* Effect.result(provider.search({ query: QUERY, maxResults: 5 }))).toStrictEqual(
        Result.fail(new ProviderProtocolInvalid({ reason: "Invalid JSON response" })),
      );
      expect(yield* Effect.result(provider.search({ query: QUERY, maxResults: 5 }))).toStrictEqual(
        Result.fail(new ProviderProtocolInvalid({ reason: "Missing results array" })),
      );
    }),
  );
});

describe("parallelMcpFetchProvider", () => {
  it.effect("calls web_fetch with full_content and extracts structured content", () =>
    Effect.gen(function* () {
      const { client, calls } = fakeMcpClient([
        Result.succeed({
          text: [],
          structuredContent: { results: [{ url: "https://example.com", content: "# Full page" }] },
        }),
      ]);
      const provider = new ParallelMcpFetchProvider(client, "session-abc");
      const result = yield* provider.fetchMarkdown(PAGE);

      expect(result).toBe("# Full page");
      expect(calls[0]?.args).toMatchObject({
        urls: [PAGE],
        full_content: true,
        session_id: "session-abc",
      });
    }),
  );

  it.effect("extracts excerpts and plain text fallbacks", () =>
    Effect.gen(function* () {
      const { client: excerptsClient } = fakeMcpClient([
        Result.succeed({
          text: [],
          structuredContent: {
            results: [{ url: "https://example.com", excerpts: ["part one", "part two"] }],
          },
        }),
      ]);
      const excerpts = yield* new ParallelMcpFetchProvider(excerptsClient, "s").fetchMarkdown(PAGE);
      expect(excerpts).toBe("part one\n\npart two");

      const { client: textClient } = fakeMcpClient([Result.succeed({ text: ["raw page text"] })]);
      const text = yield* new ParallelMcpFetchProvider(textClient, "s").fetchMarkdown(PAGE);
      expect(text).toBe("raw page text");

      const { client: emptyClient } = fakeMcpClient([Result.succeed({ text: [] })]);
      const empty = yield* new ParallelMcpFetchProvider(emptyClient, "s").fetchMarkdown(PAGE);
      expect(empty).toBeUndefined();
    }),
  );

  it.effect("reads the first result from structured content or JSON text, else the raw text", () =>
    Effect.gen(function* () {
      // Blank content falls back to the excerpts.
      expect(
        yield* fetchWith({
          text: [],
          structuredContent: { results: [{ content: "   ", excerpts: ["kept", 3] }] },
        }),
      ).toBe("kept");
      expect(
        yield* fetchWith({
          text: [JSON.stringify({ results: [{ content: " # From JSON text " }] })],
        }),
      ).toBe("# From JSON text");
      // Only the first result counts; a malformed first result leaves the raw text.
      expect(
        yield* fetchWith({
          text: ["fallback text"],
          structuredContent: { results: [null, { content: "second" }] },
        }),
      ).toBe("fallback text");
      const emptyResults = JSON.stringify({ results: [] });
      expect(yield* fetchWith({ text: [emptyResults] })).toBe(emptyResults);
    }),
  );
});
