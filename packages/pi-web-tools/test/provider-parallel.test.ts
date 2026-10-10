import { Effect, Result } from "effect";
import { assert, describe, expect, test } from "vitest";
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

async function fetchWith(result: McpToolCallResult) {
  const { client } = fakeMcpClient([Result.succeed(result)]);
  return Effect.runPromise(new ParallelMcpFetchProvider(client, "s").fetchMarkdown(PAGE));
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
  test("prefers structuredContent and falls back to JSON text", () => {
    const fromStructured = parseParallelMcpPayload({
      text: [],
      structuredContent: RESULTS_PAYLOAD,
    });
    expect(fromStructured._tag).toBe("Success");

    const fromText = parseParallelMcpPayload({ text: [JSON.stringify(RESULTS_PAYLOAD)] });
    expect(fromText._tag).toBe("Success");

    expect(parseParallelMcpPayload({ text: [] })._tag).toBe("Failure");
    expect(parseParallelMcpPayload({ text: ["not json"] })._tag).toBe("Failure");
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
  test("sends the official web_search contract including session_id", async () => {
    const { client, calls } = fakeMcpClient([
      Result.succeed({ text: [], structuredContent: RESULTS_PAYLOAD }),
    ]);
    const provider = new ParallelMcpSearchProvider(client, "session-abc");
    const result = await Effect.runPromise(
      Effect.result(provider.search({ query: QUERY, maxResults: 5 })),
    );

    assert(Result.isSuccess(result));
    expect(result.success).toHaveLength(1);
    expect(calls[0]?.name).toBe("web_search");
    expect(calls[0]?.args).toStrictEqual({
      objective: QUERY,
      search_queries: [QUERY],
      session_id: "session-abc",
    });
  });

  test("maps unparseable results to ProviderProtocolInvalid and caps maxResults", async () => {
    const { client } = fakeMcpClient([
      Result.succeed({ text: ["not json"] }),
      Result.succeed({
        text: [],
        structuredContent: { results: [...RESULTS_PAYLOAD.results, ...RESULTS_PAYLOAD.results] },
      }),
    ]);
    const provider = new ParallelMcpSearchProvider(client, "s");

    await expect(
      Effect.runPromise(Effect.result(provider.search({ query: QUERY, maxResults: 5 }))),
    ).resolves.toStrictEqual(
      Result.fail(new ProviderProtocolInvalid({ reason: "Invalid structured search results" })),
    );
    const capped = await Effect.runPromise(
      Effect.result(provider.search({ query: QUERY, maxResults: 1 })),
    );
    assert(Result.isSuccess(capped));
    expect(capped.success).toHaveLength(1);
  });
});

describe("parallelApiSearchProvider", () => {
  test("posts the official /v1/search contract", async () => {
    const { client, requests } = fakeProviderHttp([
      Result.succeed({ bodyText: JSON.stringify(RESULTS_PAYLOAD) }),
    ]);
    const provider = new ParallelApiSearchProvider("test-key", client);
    const result = await Effect.runPromise(
      Effect.result(provider.search({ query: QUERY, maxResults: 6 })),
    );

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
  });

  test("maps HTTP failures", async () => {
    const { client } = fakeProviderHttp([
      Result.fail(new ProviderTimedOut({ timeoutSeconds: 25 })),
    ]);
    const result = await Effect.runPromise(
      Effect.result(
        new ParallelApiSearchProvider("k", client).search({
          query: QUERY,
          maxResults: 5,
        }),
      ),
    );
    expect(result).toStrictEqual(Result.fail(new ProviderTimedOut({ timeoutSeconds: 25 })));
  });

  test("reports protocol failures with their reasons", async () => {
    const { client } = fakeProviderHttp([
      Result.succeed({ bodyText: "not json" }),
      Result.succeed({ bodyText: JSON.stringify({ results: {} }) }),
    ]);
    const provider = new ParallelApiSearchProvider("k", client);

    await expect(
      Effect.runPromise(Effect.result(provider.search({ query: QUERY, maxResults: 5 }))),
    ).resolves.toStrictEqual(
      Result.fail(new ProviderProtocolInvalid({ reason: "Invalid JSON response" })),
    );
    await expect(
      Effect.runPromise(Effect.result(provider.search({ query: QUERY, maxResults: 5 }))),
    ).resolves.toStrictEqual(
      Result.fail(new ProviderProtocolInvalid({ reason: "Missing results array" })),
    );
  });
});

describe("parallelMcpFetchProvider", () => {
  test("calls web_fetch with full_content and extracts structured content", async () => {
    const { client, calls } = fakeMcpClient([
      Result.succeed({
        text: [],
        structuredContent: { results: [{ url: "https://example.com", content: "# Full page" }] },
      }),
    ]);
    const provider = new ParallelMcpFetchProvider(client, "session-abc");
    const result = await Effect.runPromise(provider.fetchMarkdown(PAGE));

    expect(result).toBe("# Full page");
    expect(calls[0]?.args).toMatchObject({
      urls: [PAGE],
      full_content: true,
      session_id: "session-abc",
    });
  });

  test("extracts excerpts and plain text fallbacks", async () => {
    const { client: excerptsClient } = fakeMcpClient([
      Result.succeed({
        text: [],
        structuredContent: {
          results: [{ url: "https://example.com", excerpts: ["part one", "part two"] }],
        },
      }),
    ]);
    const excerpts = await Effect.runPromise(
      new ParallelMcpFetchProvider(excerptsClient, "s").fetchMarkdown(PAGE),
    );
    expect(excerpts).toBe("part one\n\npart two");

    const { client: textClient } = fakeMcpClient([Result.succeed({ text: ["raw page text"] })]);
    const text = await Effect.runPromise(
      new ParallelMcpFetchProvider(textClient, "s").fetchMarkdown(PAGE),
    );
    expect(text).toBe("raw page text");

    const { client: emptyClient } = fakeMcpClient([Result.succeed({ text: [] })]);
    const empty = await Effect.runPromise(
      new ParallelMcpFetchProvider(emptyClient, "s").fetchMarkdown(PAGE),
    );
    expect(empty).toBeUndefined();
  });

  test("reads the first result from structured content or JSON text, else the raw text", async () => {
    // Blank content falls back to the excerpts.
    await expect(
      fetchWith({
        text: [],
        structuredContent: { results: [{ content: "   ", excerpts: ["kept", 3] }] },
      }),
    ).resolves.toBe("kept");
    await expect(
      fetchWith({ text: [JSON.stringify({ results: [{ content: " # From JSON text " }] })] }),
    ).resolves.toBe("# From JSON text");
    // Only the first result counts; a malformed first result leaves the raw text.
    await expect(
      fetchWith({
        text: ["fallback text"],
        structuredContent: { results: [null, { content: "second" }] },
      }),
    ).resolves.toBe("fallback text");
    const emptyResults = JSON.stringify({ results: [] });
    await expect(fetchWith({ text: [emptyResults] })).resolves.toBe(emptyResults);
  });
});
