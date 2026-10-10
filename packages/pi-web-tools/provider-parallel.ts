import { Effect, Result } from "effect";
import { z } from "zod";
import type { McpClient, McpToolCallResult } from "./mcp";
import { readProviderJson } from "./provider-http";
import type { ProviderHttpClient } from "./provider-http";
import {
  lenientArray,
  optionalTextSchema,
  parseJsonBody,
  ProviderProtocolInvalid,
  publicHttpUrlSchema,
} from "./provider-types";
import type { FetchProvider, ProviderError, SearchInput, SearchProvider } from "./provider-types";
import {
  PARALLEL_API_SEARCH_URL,
  SEARCH_MAX_RESPONSE_BYTES,
  SEARCH_TIMEOUT_SECONDS,
} from "./settings";
import type { NormalizedSearchResult, PublicHttpUrl } from "./types";

const PARALLEL_SEARCH_TIMEOUT_MS = SEARCH_TIMEOUT_SECONDS.default * 1000;

/** Excerpt strings joined into one block; undefined when none carry text. */
const excerptsSchema = lenientArray(z.string())
  .catch([])
  .transform((excerpts) => excerpts.join("\n\n").trim() || undefined);

const parallelResultSchema = z
  .object({
    url: publicHttpUrlSchema,
    title: optionalTextSchema,
    publish_date: optionalTextSchema,
    excerpts: excerptsSchema,
  })
  .transform((item): NormalizedSearchResult => ({
    title: item.title ?? item.url,
    url: item.url,
    snippet: item.excerpts,
    publishedAt: item.publish_date,
    source: "Parallel",
  }));

const parallelResultsPayloadSchema = z.object({ results: lenientArray(parallelResultSchema) });

// Only the first result is read: it answers the single URL each web_fetch call asks for.
const parallelFetchPayloadSchema = z.object({
  results: z.tuple(
    [
      z
        .object({ content: optionalTextSchema, excerpts: excerptsSchema })
        .transform((item) => item.content ?? item.excerpts),
    ],
    z.unknown(),
  ),
});

/** Parse Parallel's structured results payload (MCP structuredContent, JSON text, or REST body). */
export function parseParallelResults(
  payload: unknown,
): Result.Result<readonly NormalizedSearchResult[], string> {
  const parsed = parallelResultsPayloadSchema.safeParse(payload);
  return parsed.success
    ? Result.succeed(parsed.data.results)
    : Result.fail("Missing results array");
}

/** Extract Parallel's results payload from an MCP tool result (structuredContent or JSON text). */
export function parseParallelMcpPayload(
  toolResult: McpToolCallResult,
): Result.Result<readonly NormalizedSearchResult[], string> {
  if (toolResult.structuredContent !== undefined) {
    return parseParallelResults(toolResult.structuredContent);
  }

  const [firstText] = toolResult.text;
  if (firstText === undefined) {
    return Result.fail("Missing structured search results");
  }
  const payload = parseJsonBody(firstText);
  return Result.isSuccess(payload)
    ? parseParallelResults(payload.success)
    : Result.fail("Invalid structured search results");
}

/** Search Parallel through its official hosted MCP endpoint (keyless or proxied). */
export class ParallelMcpSearchProvider implements SearchProvider {
  readonly name = "parallel" as const;
  readonly transport = "mcp" as const;

  constructor(
    private readonly mcp: McpClient,
    private readonly sessionId: string,
  ) {}

  /** Run one Parallel MCP web_search call and normalize its structured results. */
  search(input: SearchInput): Effect.Effect<readonly NormalizedSearchResult[], ProviderError> {
    return this.mcp
      .callTool("web_search", {
        objective: input.query,
        search_queries: [input.query],
        session_id: this.sessionId,
      })
      .pipe(
        Effect.flatMap((call) => limitedResults(parseParallelMcpPayload(call), input.maxResults)),
      );
  }
}

/** Search Parallel through its official REST API (GA /v1/search) when an API key is configured. */
export class ParallelApiSearchProvider implements SearchProvider {
  readonly name = "parallel" as const;
  readonly transport = "api" as const;

  constructor(
    private readonly apiKey: string,
    private readonly http: ProviderHttpClient,
  ) {}

  /** Run one Parallel REST search call and normalize its structured results. */
  search(input: SearchInput): Effect.Effect<readonly NormalizedSearchResult[], ProviderError> {
    return readProviderJson(
      this.http.postJson({
        url: PARALLEL_API_SEARCH_URL,
        headers: { "x-api-key": this.apiKey },
        body: {
          objective: input.query,
          search_queries: [input.query],
          max_results: input.maxResults,
          mode: "fast",
        },
        maxResponseBytes: SEARCH_MAX_RESPONSE_BYTES,
        timeoutMs: PARALLEL_SEARCH_TIMEOUT_MS,
      }),
    ).pipe(
      Effect.flatMap((payload) => limitedResults(parseParallelResults(payload), input.maxResults)),
    );
  }
}

function limitedResults(
  parsed: Result.Result<readonly NormalizedSearchResult[], string>,
  maxResults: number,
): Effect.Effect<readonly NormalizedSearchResult[], ProviderProtocolInvalid> {
  return Result.isSuccess(parsed)
    ? Effect.succeed(parsed.success.slice(0, maxResults))
    : Effect.fail(new ProviderProtocolInvalid({ reason: parsed.failure }));
}

/** Fetch a page through Parallel's hosted MCP web_fetch tool (the fetch rescue path). */
export class ParallelMcpFetchProvider implements FetchProvider {
  readonly name = "parallel" as const;

  constructor(
    private readonly mcp: McpClient,
    private readonly sessionId: string,
  ) {}

  /** Read one URL as full markdown through Parallel's fetch infrastructure; undefined on any failure. */
  fetchMarkdown(url: PublicHttpUrl): Effect.Effect<string | undefined> {
    return this.mcp
      .callTool("web_fetch", { urls: [url], full_content: true, session_id: this.sessionId })
      .pipe(
        Effect.map(readParallelFetchResult),
        Effect.orElseSucceed(() => undefined),
      );
  }
}

function readParallelFetchResult(call: McpToolCallResult): string | undefined {
  const fromStructured = extractParallelFetchText(call.structuredContent);
  if (fromStructured !== undefined && fromStructured !== "") {
    return fromStructured;
  }

  const text = call.text.join("\n\n").trim();
  if (!text) {
    return undefined;
  }
  // Some deployments return the results payload as JSON text instead of structuredContent.
  const payload = parseJsonBody(text);
  const fromJson = Result.isSuccess(payload)
    ? extractParallelFetchText(payload.success)
    : undefined;
  // Not a results payload: treat the text as the page content itself.
  return fromJson ?? text;
}

function extractParallelFetchText(payload: unknown): string | undefined {
  return parallelFetchPayloadSchema.safeParse(payload).data?.results[0];
}
