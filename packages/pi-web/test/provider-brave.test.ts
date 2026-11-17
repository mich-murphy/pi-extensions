import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Redacted, Result } from "effect";
import { BraveApiSearchProvider } from "../provider-brave";
import { ProviderProtocolInvalid, ProviderStatusRejected } from "../provider-types";
import { fakeProviderHttp, searchQuery } from "./fakes";

const QUERY = searchQuery("brave search api");

describe("braveApiSearchProvider", () => {
  it.effect("sends the official contract with the subscription token header", () =>
    Effect.gen(function* () {
      const { client, requests } = fakeProviderHttp([
        Result.succeed({
          bodyText: JSON.stringify({
            web: {
              results: [
                {
                  title: "Brave Search API",
                  url: "https://brave.com/search/api/",
                  description: "Independent search index.",
                  page_age: "2026-01-15",
                },
              ],
            },
          }),
        }),
      ]);
      const provider = new BraveApiSearchProvider(Redacted.make("BSA_test"), client);
      const result = yield* Effect.result(provider.search({ query: QUERY, maxResults: 10 }));

      assert(Result.isSuccess(result));
      expect(result.success[0]?.title).toBe("Brave Search API");
      expect(result.success[0]?.snippet).toBe("Independent search index.");
      expect(result.success[0]?.publishedAt).toBe("2026-01-15");

      const [request] = requests;
      assert(request !== undefined);
      const url = new URL(request.url);
      expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
      expect(url.searchParams.get("q")).toBe(QUERY);
      expect(url.searchParams.get("count")).toBe("10");
      expect(url.searchParams.get("safesearch")).toBe("moderate");
      expect(request.headers["x-subscription-token"]).toBe("BSA_test");
    }),
  );

  it.effect("propagates HTTP failures and reports missing web results", () =>
    Effect.gen(function* () {
      const { client } = fakeProviderHttp([
        Result.fail(new ProviderStatusRejected({ status: 422 })),
      ]);
      const result = yield* Effect.result(
        new BraveApiSearchProvider(Redacted.make("k"), client).search({
          query: QUERY,
          maxResults: 5,
        }),
      );
      expect(result).toStrictEqual(Result.fail(new ProviderStatusRejected({ status: 422 })));

      const { client: emptyClient } = fakeProviderHttp([
        Result.succeed({ bodyText: JSON.stringify({}) }),
      ]);
      const empty = yield* Effect.result(
        new BraveApiSearchProvider(Redacted.make("k"), emptyClient).search({
          query: QUERY,
          maxResults: 5,
        }),
      );
      expect(empty).toStrictEqual(
        Result.fail(new ProviderProtocolInvalid({ reason: "Missing web results" })),
      );
    }),
  );

  it.effect("skips invalid items and falls back when a field has the wrong type", () =>
    Effect.gen(function* () {
      const { client } = fakeProviderHttp([
        Result.succeed({
          bodyText: JSON.stringify({
            web: {
              results: [
                null,
                "not an object",
                ["https://array.example"],
                { title: "No URL" },
                { url: 42 },
                { url: "notaurl", title: "Bad URL" },
                {
                  url: "https://a.example",
                  title: 7,
                  description: ["not text"],
                  page_age: 3,
                  age: "2 days ago",
                },
                { url: "https://b.example", title: "  B  ", description: "  About B.  " },
              ],
            },
          }),
        }),
      ]);
      const result = yield* Effect.result(
        new BraveApiSearchProvider(Redacted.make("k"), client).search({
          query: QUERY,
          maxResults: 10,
        }),
      );

      expect(result).toStrictEqual(
        Result.succeed([
          {
            title: "https://a.example/",
            url: "https://a.example/",
            snippet: undefined,
            publishedAt: "2 days ago",
            source: "Brave",
          },
          {
            title: "B",
            url: "https://b.example/",
            snippet: "About B.",
            publishedAt: undefined,
            source: "Brave",
          },
        ]),
      );
    }),
  );

  it.effect("reports protocol failures with their reasons", () =>
    Effect.gen(function* () {
      const { client } = fakeProviderHttp([
        Result.succeed({ bodyText: "not json" }),
        Result.succeed({ bodyText: JSON.stringify({ web: { results: "nope" } }) }),
        Result.succeed({ bodyText: JSON.stringify({ web: [] }) }),
      ]);
      const provider = new BraveApiSearchProvider(Redacted.make("k"), client);
      const search = () => Effect.result(provider.search({ query: QUERY, maxResults: 5 }));

      expect(yield* search()).toStrictEqual(
        Result.fail(new ProviderProtocolInvalid({ reason: "Invalid JSON response" })),
      );
      const missing = Result.fail(new ProviderProtocolInvalid({ reason: "Missing web results" }));
      expect(yield* search()).toStrictEqual(missing);
      expect(yield* search()).toStrictEqual(missing);
    }),
  );

  it.effect("caps results at maxResults", () =>
    Effect.gen(function* () {
      const results = ["a", "b", "c"].map((host) => ({ url: `https://${host}.example` }));
      const { client } = fakeProviderHttp([
        Result.succeed({ bodyText: JSON.stringify({ web: { results } }) }),
      ]);
      const result = yield* Effect.result(
        new BraveApiSearchProvider(Redacted.make("k"), client).search({
          query: QUERY,
          maxResults: 2,
        }),
      );

      assert(Result.isSuccess(result));
      expect(result.success.map((item) => item.url)).toStrictEqual([
        "https://a.example/",
        "https://b.example/",
      ]);
    }),
  );
});
