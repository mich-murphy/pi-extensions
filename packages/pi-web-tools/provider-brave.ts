import { Duration, Effect, Redacted, Result, Schema } from "effect";
import { readProviderJson } from "./provider-http";
import type { ProviderHttpClient } from "./provider-http";
import {
  lenientArray,
  optionalTextSchema,
  orFallback,
  ProviderProtocolInvalid,
  publicHttpUrlSchema,
} from "./provider-types";
import type { ProviderError, SearchInput, SearchProvider } from "./provider-types";
import {
  BRAVE_API_SEARCH_URL,
  SEARCH_MAX_RESPONSE_BYTES,
  SEARCH_TIMEOUT_SECONDS,
} from "./settings";
import type { NormalizedSearchResult } from "./types";

const BRAVE_SEARCH_TIMEOUT = Duration.seconds(SEARCH_TIMEOUT_SECONDS.default);

const BraveResult = Schema.Struct({
  url: publicHttpUrlSchema,
  title: optionalTextSchema,
  description: optionalTextSchema,
  // Dates pass through untrimmed; a string page_age wins over age even when empty.
  page_age: orFallback(Schema.UndefinedOr(Schema.String), undefined),
  age: orFallback(Schema.UndefinedOr(Schema.String), undefined),
});

function normalizeBraveResult(item: typeof BraveResult.Type): NormalizedSearchResult {
  const publishedAt = item.page_age ?? item.age;
  return {
    title: item.title ?? item.url,
    url: item.url,
    snippet: item.description,
    publishedAt: publishedAt === "" ? undefined : publishedAt,
    source: "Brave",
  };
}

const decodeBraveSearchPayload = Schema.decodeUnknownResult(
  Schema.Struct({ web: Schema.Struct({ results: lenientArray(BraveResult) }) }),
);

/** Search Brave through its official REST API. Only available when BRAVE_API_KEY is configured. */
export class BraveApiSearchProvider implements SearchProvider {
  readonly name = "brave" as const;
  readonly transport = "api" as const;

  constructor(
    private readonly apiKey: Redacted.Redacted,
    private readonly http: ProviderHttpClient["Service"],
  ) {}

  /** Run one Brave web search call and normalize its results. */
  search(input: SearchInput): Effect.Effect<readonly NormalizedSearchResult[], ProviderError> {
    const url = new URL(BRAVE_API_SEARCH_URL);
    url.searchParams.set("q", input.query);
    url.searchParams.set("count", String(input.maxResults));
    url.searchParams.set("safesearch", "moderate");
    url.searchParams.set("text_decorations", "false");

    return readProviderJson(
      this.http.getJson({
        url: url.toString(),
        headers: {
          accept: "application/json",
          "accept-encoding": "gzip",
          "x-subscription-token": Redacted.value(this.apiKey),
        },
        maxResponseBytes: SEARCH_MAX_RESPONSE_BYTES,
        timeout: BRAVE_SEARCH_TIMEOUT,
      }),
    ).pipe(
      Effect.flatMap((payload) => {
        const parsed = decodeBraveSearchPayload(payload);
        return Result.isSuccess(parsed)
          ? Effect.succeed(
              parsed.success.web.results
                .slice(0, input.maxResults)
                .map((item) => normalizeBraveResult(item)),
            )
          : Effect.fail(new ProviderProtocolInvalid({ reason: "Missing web results" }));
      }),
    );
  }
}
