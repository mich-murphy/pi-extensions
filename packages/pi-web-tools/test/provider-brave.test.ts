import { assert, describe, expect, test } from "vitest";
import { BraveApiSearchProvider } from "../provider-brave";
import { err, ok } from "../result";
import { fakeProviderHttp, searchQuery } from "./fakes";

const QUERY = searchQuery("brave search api");

describe("braveApiSearchProvider", () => {
  test("sends the official contract with the subscription token header", async () => {
    const { client, requests } = fakeProviderHttp([
      ok({
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
    const provider = new BraveApiSearchProvider("BSA_test", client);
    const result = await provider.search({ query: QUERY, maxResults: 10 });

    assert(result._tag === "ok");
    expect(result.value[0]?.title).toBe("Brave Search API");
    expect(result.value[0]?.snippet).toBe("Independent search index.");
    expect(result.value[0]?.publishedAt).toBe("2026-01-15");

    const [request] = requests;
    assert(request !== undefined);
    const url = new URL(request.url);
    expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
    expect(url.searchParams.get("q")).toBe(QUERY);
    expect(url.searchParams.get("count")).toBe("10");
    expect(url.searchParams.get("safesearch")).toBe("moderate");
    expect(request.headers["x-subscription-token"]).toBe("BSA_test");
  });

  test("maps HTTP failures and missing web results", async () => {
    const { client } = fakeProviderHttp([err({ _tag: "ProviderStatusRejected", status: 422 })]);
    const result = await new BraveApiSearchProvider("k", client).search({
      query: QUERY,
      maxResults: 5,
    });
    expect(result).toStrictEqual({
      _tag: "err",
      error: { _tag: "ProviderStatusRejected", status: 422 },
    });

    const { client: emptyClient } = fakeProviderHttp([ok({ bodyText: JSON.stringify({}) })]);
    const empty = await new BraveApiSearchProvider("k", emptyClient).search({
      query: QUERY,
      maxResults: 5,
    });
    expect(empty._tag).toBe("err");
  });

  test("skips invalid items and falls back when a field has the wrong type", async () => {
    const { client } = fakeProviderHttp([
      ok({
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
    const result = await new BraveApiSearchProvider("k", client).search({
      query: QUERY,
      maxResults: 10,
    });

    expect(result).toStrictEqual(
      ok([
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
  });

  test("reports protocol failures with their reasons", async () => {
    const { client } = fakeProviderHttp([
      ok({ bodyText: "not json" }),
      ok({ bodyText: JSON.stringify({ web: { results: "nope" } }) }),
      ok({ bodyText: JSON.stringify({ web: [] }) }),
    ]);
    const provider = new BraveApiSearchProvider("k", client);
    const search = async () => provider.search({ query: QUERY, maxResults: 5 });

    await expect(search()).resolves.toStrictEqual(
      err({ _tag: "ProviderProtocolInvalid", reason: "Invalid JSON response" }),
    );
    const missing = err({ _tag: "ProviderProtocolInvalid", reason: "Missing web results" });
    await expect(search()).resolves.toStrictEqual(missing);
    await expect(search()).resolves.toStrictEqual(missing);
  });

  test("caps results at maxResults", async () => {
    const results = ["a", "b", "c"].map((host) => ({ url: `https://${host}.example` }));
    const { client } = fakeProviderHttp([ok({ bodyText: JSON.stringify({ web: { results } }) })]);
    const result = await new BraveApiSearchProvider("k", client).search({
      query: QUERY,
      maxResults: 2,
    });

    assert(result._tag === "ok");
    expect(result.value.map((item) => item.url)).toStrictEqual([
      "https://a.example/",
      "https://b.example/",
    ]);
  });
});
