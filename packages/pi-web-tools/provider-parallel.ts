import { z } from "zod";
import type { McpClient, McpToolCallResult } from "./mcp";
import { readProviderJson } from "./provider-http";
import type { ProviderHttpClient } from "./provider-http";
import {
  lenientArray,
  optionalTextSchema,
  parseJsonBody,
  publicHttpUrlSchema,
} from "./provider-types";
import type {
  FetchProvider,
  ProviderCallOptions,
  ProviderError,
  SearchInput,
  SearchProvider,
} from "./provider-types";
import { err, ok } from "./result";
import type { Result } from "./result";
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
): Result<readonly NormalizedSearchResult[], string> {
  const parsed = parallelResultsPayloadSchema.safeParse(payload);
  return parsed.success ? ok(parsed.data.results) : err("Missing results array");
}

/** Extract Parallel's results payload from an MCP tool result (structuredContent or JSON text). */
export function parseParallelMcpPayload(
  toolResult: McpToolCallResult,
): Result<readonly NormalizedSearchResult[], string> {
  if (toolResult.structuredContent !== undefined) {
    return parseParallelResults(toolResult.structuredContent);
  }

  const [firstText] = toolResult.text;
  if (firstText === undefined) {
    return err("Missing structured search results");
  }
  const payload = parseJsonBody(firstText);
  return payload._tag === "ok"
    ? parseParallelResults(payload.value)
    : err("Invalid structured search results");
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
  async search(
    input: SearchInput,
    options: ProviderCallOptions = {},
  ): Promise<Result<readonly NormalizedSearchResult[], ProviderError>> {
    const call = await this.mcp.callTool(
      "web_search",
      {
        objective: input.query,
        search_queries: [input.query],
        session_id: this.sessionId,
      },
      { signal: options.signal },
    );
    if (call._tag === "err") {
      return call;
    }

    const parsed = parseParallelMcpPayload(call.value);
    if (parsed._tag === "err") {
      return err({ _tag: "ProviderProtocolInvalid", reason: parsed.error });
    }
    return ok(parsed.value.slice(0, input.maxResults));
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
  async search(
    input: SearchInput,
    options: ProviderCallOptions = {},
  ): Promise<Result<readonly NormalizedSearchResult[], ProviderError>> {
    const response = this.http.postJson(
      {
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
      },
      { signal: options.signal },
    );
    const payload = await readProviderJson(response);
    if (payload._tag === "err") {
      return payload;
    }
    const parsed = parseParallelResults(payload.value);
    if (parsed._tag === "err") {
      return err({ _tag: "ProviderProtocolInvalid", reason: parsed.error });
    }
    return ok(parsed.value.slice(0, input.maxResults));
  }
}

/** Fetch a page through Parallel's hosted MCP web_fetch tool (the fetch rescue path). */
export class ParallelMcpFetchProvider implements FetchProvider {
  readonly name = "parallel" as const;

  constructor(
    private readonly mcp: McpClient,
    private readonly sessionId: string,
  ) {}

  /** Read one URL as full markdown through Parallel's fetch infrastructure. */
  async fetchMarkdown(
    url: PublicHttpUrl,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<string | undefined> {
    const call = await this.mcp.callTool(
      "web_fetch",
      { urls: [url], full_content: true, session_id: this.sessionId },
      { signal: options.signal },
    );
    if (call._tag === "err") {
      return undefined;
    }

    const fromStructured = extractParallelFetchText(call.value.structuredContent);
    if (fromStructured !== undefined && fromStructured !== "") {
      return fromStructured;
    }

    const text = call.value.text.join("\n\n").trim();
    if (!text) {
      return undefined;
    }
    // Some deployments return the results payload as JSON text instead of structuredContent.
    const payload = parseJsonBody(text);
    const fromJson = payload._tag === "ok" ? extractParallelFetchText(payload.value) : undefined;
    // Not a results payload: treat the text as the page content itself.
    return fromJson ?? text;
  }
}

function extractParallelFetchText(payload: unknown): string | undefined {
  return parallelFetchPayloadSchema.safeParse(payload).data?.results[0];
}
