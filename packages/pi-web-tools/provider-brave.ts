import { z } from "zod";
import type { ProviderHttpClient } from "./provider-http";
import {
  lenientArray,
  optionalTextSchema,
  type ProviderError,
  parseJsonBody,
  publicHttpUrlSchema,
  type SearchProvider,
} from "./provider-types";
import { err, ok, type Result } from "./result";
import {
  BRAVE_API_SEARCH_URL,
  SEARCH_MAX_RESPONSE_BYTES,
  SEARCH_TIMEOUT_SECONDS,
} from "./settings";
import type { NormalizedSearchResult, SearchQuery } from "./types";

const BRAVE_SEARCH_TIMEOUT_MS = SEARCH_TIMEOUT_SECONDS.default * 1_000;

const braveResultSchema = z
  .object({
    url: publicHttpUrlSchema,
    title: optionalTextSchema,
    description: optionalTextSchema,
    // Dates pass through untrimmed; a string page_age wins over age even when empty.
    page_age: z.string().optional().catch(undefined),
    age: z.string().optional().catch(undefined),
  })
  .transform(
    (item): NormalizedSearchResult => ({
      title: item.title ?? item.url,
      url: item.url,
      snippet: item.description,
      publishedAt: (item.page_age ?? item.age) || undefined,
      source: "Brave",
    }),
  );

const braveSearchPayloadSchema = z.object({
  web: z.object({ results: lenientArray(braveResultSchema) }),
});

/** Search Brave through its official REST API. Only available when BRAVE_API_KEY is configured. */
export class BraveApiSearchProvider implements SearchProvider {
  readonly name = "brave" as const;
  readonly transport = "api" as const;

  constructor(
    private readonly apiKey: string,
    private readonly http: ProviderHttpClient,
  ) {}

  /** Run one Brave web search call and normalize its results. */
  async search(
    input: { readonly query: SearchQuery; readonly maxResults: number },
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<Result<readonly NormalizedSearchResult[], ProviderError>> {
    const url = new URL(BRAVE_API_SEARCH_URL);
    url.searchParams.set("q", input.query);
    url.searchParams.set("count", String(input.maxResults));
    url.searchParams.set("safesearch", "moderate");
    url.searchParams.set("text_decorations", "false");

    const response = await this.http.getJson(
      {
        url: url.toString(),
        headers: {
          accept: "application/json",
          "accept-encoding": "gzip",
          "x-subscription-token": this.apiKey,
        },
        maxResponseBytes: SEARCH_MAX_RESPONSE_BYTES,
        timeoutMs: BRAVE_SEARCH_TIMEOUT_MS,
      },
      { signal: options.signal },
    );
    if (response._tag === "err") {
      return response;
    }

    const payload = parseJsonBody(response.value.bodyText);
    if (payload._tag === "err") {
      return payload;
    }
    const parsed = braveSearchPayloadSchema.safeParse(payload.value);
    if (!parsed.success) {
      return err({ _tag: "ProviderProtocolInvalid", reason: "Missing web results" });
    }
    return ok(parsed.data.web.results.slice(0, input.maxResults));
  }
}
