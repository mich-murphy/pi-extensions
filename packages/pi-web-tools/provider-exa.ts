import { z } from "zod";
import type { McpClient } from "./mcp";
import type { ProviderHttpClient } from "./provider-http";
import {
  type FetchProvider,
  lenientArray,
  optionalTextSchema,
  type ProviderError,
  parseJsonBody,
  publicHttpUrlSchema,
  type SearchProvider,
} from "./provider-types";
import { err, ok, type Result } from "./result";
import {
  EXA_API_CONTENTS_URL,
  EXA_API_SEARCH_URL,
  SEARCH_MAX_RESPONSE_BYTES,
  SEARCH_TIMEOUT_SECONDS,
} from "./settings";
import {
  type NormalizedSearchResult,
  type PublicHttpUrl,
  parsePublicHttpUrl,
  type SearchQuery,
} from "./types";

const EXA_SEARCH_TIMEOUT_MS = SEARCH_TIMEOUT_SECONDS.default * 1_000;
const EXA_FETCH_MAX_CHARACTERS = 60_000;

/** Parse Exa MCP's untrusted text search-result format into normalized results. */
export function parseExaSearchText(input: string): {
  readonly results: readonly NormalizedSearchResult[];
  readonly discardedSections: number;
} {
  const trimmed = input.replace(/\r\n/g, "\n").trim();
  if (!trimmed || isExplicitNoResultsText(trimmed)) {
    return { results: [], discardedSections: 0 };
  }

  const sections = splitSearchSections(trimmed);
  const results: NormalizedSearchResult[] = [];
  let discardedSections = 0;

  for (const section of sections) {
    const parsed = parseSearchSection(section);
    if (!parsed) {
      discardedSections += 1;
      continue;
    }
    results.push(parsed);
  }

  return { results, discardedSections };
}

function splitSearchSections(input: string): string[] {
  const lines = input.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  let sawUrlOrText = false;

  for (const line of lines) {
    if (line.startsWith("Title: ") && current.length > 0 && sawUrlOrText) {
      sections.push(current.join("\n").trim());
      current = [line];
      sawUrlOrText = false;
      continue;
    }
    if (line.startsWith("URL: ") || line.startsWith("Text:") || line.startsWith("Highlights:")) {
      sawUrlOrText = true;
    }
    current.push(line);
  }

  if (current.length > 0) {
    sections.push(current.join("\n").trim());
  }

  return sections.filter((section) => section.length > 0);
}

/** Header fields an Exa MCP search section can carry before its snippet. */
type ExaHeaderField = "title" | "url" | "publishedAt" | "source" | "author" | "score";

/** One header line prefix, the field it fills, and how its raw value becomes usable. */
interface ExaHeaderRule {
  readonly prefix: string;
  readonly field: ExaHeaderField;
  readonly normalize: (raw: string) => string | undefined;
}

/**
 * Header prefixes of an Exa MCP search section. For every field the last line
 * with a usable value wins; placeholder metadata (see normalizeMetadataValue),
 * blank values, and non-numeric scores never clear an earlier value.
 * `Published Date:` and `Published:` are aliases for the same field.
 */
const EXA_HEADER_RULES: readonly ExaHeaderRule[] = [
  { prefix: "Title: ", field: "title", normalize: normalizeNonEmpty },
  { prefix: "URL: ", field: "url", normalize: normalizeNonEmpty },
  { prefix: "Published Date: ", field: "publishedAt", normalize: normalizeMetadataValue },
  { prefix: "Published: ", field: "publishedAt", normalize: normalizeMetadataValue },
  { prefix: "Source: ", field: "source", normalize: normalizeMetadataValue },
  { prefix: "Author: ", field: "author", normalize: normalizeMetadataValue },
  { prefix: "Score: ", field: "score", normalize: normalizeScore },
];

function parseSearchSection(section: string): NormalizedSearchResult | undefined {
  const lines = section.split("\n");
  // The first Text:/Highlights: line starts the snippet; everything after it is snippet text.
  const snippetStart = lines.findIndex(
    (line) => line.startsWith("Text:") || line.startsWith("Highlights:"),
  );
  const headerLines = snippetStart === -1 ? lines : lines.slice(0, snippetStart);
  const snippetLines = snippetStart === -1 ? [] : lines.slice(snippetStart);
  const headers = readSectionHeaders(headerLines);

  const url = headers.get("url");
  if (url === undefined) {
    return undefined;
  }
  const parsedUrl = parsePublicHttpUrl(url);
  if (parsedUrl._tag === "err") {
    return undefined;
  }

  const [firstSnippetLine = "", ...restSnippetLines] = snippetLines;
  const snippetText = [
    firstSnippetLine.slice(firstSnippetLine.indexOf(":") + 1).trim(),
    ...restSnippetLines,
  ].join("\n");
  const title = headers.get("title") ?? "";
  const score = headers.get("score");
  return {
    title: title || parsedUrl.value,
    url: parsedUrl.value,
    snippet: summarizeSnippet(snippetText, title),
    publishedAt: headers.get("publishedAt"),
    // Source beats Author; Author only names the source when no usable Source line exists.
    source: headers.get("source") ?? headers.get("author"),
    score: score === undefined ? undefined : Number.parseFloat(score),
  };
}

function readSectionHeaders(lines: readonly string[]): ReadonlyMap<ExaHeaderField, string> {
  const headers = new Map<ExaHeaderField, string>();
  for (const line of lines) {
    const rule = EXA_HEADER_RULES.find((candidate) => line.startsWith(candidate.prefix));
    if (rule === undefined) continue;
    const value = rule.normalize(line.slice(rule.prefix.length));
    if (value !== undefined) {
      headers.set(rule.field, value);
    }
  }
  return headers;
}

function normalizeNonEmpty(value: string): string | undefined {
  return value.trim() || undefined;
}

function normalizeScore(value: string): string | undefined {
  const trimmed = value.trim();
  return Number.isFinite(Number.parseFloat(trimmed)) ? trimmed : undefined;
}

function summarizeSnippet(text: string, title: string): string | undefined {
  const collapsed = text
    .replace(/\r\n/g, "\n")
    .replace(/^\s*---+\s*$/gm, "")
    .replace(/^#+\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!collapsed) return undefined;

  let snippet = collapsed;
  if (title) {
    snippet = stripRepeatedLeadingTitle(snippet, title);
  }
  if (!snippet) snippet = collapsed;
  if (snippet.length <= 280) return snippet;
  return `${snippet.slice(0, 277).trimEnd()}...`;
}

function stripRepeatedLeadingTitle(snippet: string, title: string): string {
  const normalizedTitle = title.trim().toLowerCase();
  const lines = snippet.split("\n");
  // Skip leading blank lines and every leading repeat of the title.
  const bodyStart = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && trimmed.toLowerCase() !== normalizedTitle;
  });
  return bodyStart === -1 ? "" : lines.slice(bodyStart).join("\n").trim();
}

/** Metadata values Exa uses to mean "absent", compared case-insensitively. */
const PLACEHOLDER_METADATA_VALUES: ReadonlySet<string> = new Set([
  "n/a",
  "na",
  "none",
  "null",
  "undefined",
  "unknown",
]);

function normalizeMetadataValue(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized || PLACEHOLDER_METADATA_VALUES.has(normalized.toLowerCase())) {
    return undefined;
  }
  return normalized;
}

function isExplicitNoResultsText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true;
  return normalized.startsWith("no results found") || normalized.includes("no relevant results");
}

/** Search Exa through its official hosted MCP endpoint (keyless or proxied). */
export class ExaMcpSearchProvider implements SearchProvider {
  readonly name = "exa" as const;
  readonly transport = "mcp" as const;

  constructor(private readonly mcp: McpClient) {}

  /** Run one Exa MCP web_search_exa call and parse its text results. */
  async search(
    input: { readonly query: SearchQuery; readonly maxResults: number },
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<Result<readonly NormalizedSearchResult[], ProviderError>> {
    const call = await this.mcp.callTool(
      "web_search_exa",
      {
        query: input.query,
        // The hosted endpoint requires an objective; the query is the objective we have.
        objective: input.query,
        numResults: input.maxResults,
      },
      { signal: options.signal },
    );
    if (call._tag === "err") {
      return call;
    }

    const parsed = parseExaSearchText(call.value.text.join("\n\n"));
    return ok(parsed.results.slice(0, input.maxResults));
  }
}

const exaApiResultSchema = z
  .object({
    url: publicHttpUrlSchema,
    title: optionalTextSchema,
    highlights: lenientArray(z.string()).catch([]),
    // Exa's metadata passes through as sent, untrimmed.
    publishedDate: z.string().optional().catch(undefined),
    author: z.string().optional().catch(undefined),
    score: z.number().optional().catch(undefined),
  })
  .transform(
    (item): NormalizedSearchResult => ({
      title: item.title ?? item.url,
      url: item.url,
      snippet: summarizeSnippet(item.highlights.join("\n"), item.title ?? ""),
      publishedAt: item.publishedDate,
      source: item.author,
      score: item.score,
    }),
  );

const exaApiSearchPayloadSchema = z.object({ results: lenientArray(exaApiResultSchema) });

// Only the first result is read: it answers the single URL each request asks for.
const exaApiContentsPayloadSchema = z.object({
  results: z.tuple([z.object({ text: optionalTextSchema })], z.unknown()),
});

/** Search Exa through its official REST API when an API key is configured. */
export class ExaApiSearchProvider implements SearchProvider {
  readonly name = "exa" as const;
  readonly transport = "api" as const;

  constructor(
    private readonly apiKey: string,
    private readonly http: ProviderHttpClient,
  ) {}

  /** Run one Exa REST /search call and normalize its structured results. */
  async search(
    input: { readonly query: SearchQuery; readonly maxResults: number },
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<Result<readonly NormalizedSearchResult[], ProviderError>> {
    const response = await this.http.postJson(
      {
        url: EXA_API_SEARCH_URL,
        headers: { "x-api-key": this.apiKey },
        body: {
          query: input.query,
          type: "auto",
          numResults: input.maxResults,
          livecrawl: "fallback",
          contents: { highlights: true },
        },
        maxResponseBytes: SEARCH_MAX_RESPONSE_BYTES,
        timeoutMs: EXA_SEARCH_TIMEOUT_MS,
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
    const parsed = exaApiSearchPayloadSchema.safeParse(payload.value);
    if (!parsed.success) {
      return err({ _tag: "ProviderProtocolInvalid", reason: "Missing results array" });
    }
    return ok(parsed.data.results.slice(0, input.maxResults));
  }
}

/** Fetch a page through Exa's hosted MCP web_fetch_exa tool (the fetch rescue path). */
export class ExaMcpFetchProvider implements FetchProvider {
  readonly name = "exa" as const;

  constructor(private readonly mcp: McpClient) {}

  /** Read one URL as markdown through Exa's crawl infrastructure. */
  async fetchMarkdown(
    url: PublicHttpUrl,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<string | undefined> {
    const call = await this.mcp.callTool(
      "web_fetch_exa",
      { urls: [url], maxCharacters: EXA_FETCH_MAX_CHARACTERS },
      { signal: options.signal },
    );
    if (call._tag === "err") {
      return undefined;
    }
    return call.value.text.join("\n\n").trim() || undefined;
  }
}

/** Fetch a page through Exa's REST /contents endpoint when an API key is configured. */
export class ExaApiFetchProvider implements FetchProvider {
  readonly name = "exa" as const;

  constructor(
    private readonly apiKey: string,
    private readonly http: ProviderHttpClient,
  ) {}

  /** Read one URL as text through Exa's REST contents API. */
  async fetchMarkdown(
    url: PublicHttpUrl,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<string | undefined> {
    const response = await this.http.postJson(
      {
        url: EXA_API_CONTENTS_URL,
        headers: { "x-api-key": this.apiKey },
        body: {
          urls: [url],
          text: { maxCharacters: EXA_FETCH_MAX_CHARACTERS },
          livecrawl: "preferred",
        },
        maxResponseBytes: SEARCH_MAX_RESPONSE_BYTES,
        timeoutMs: EXA_SEARCH_TIMEOUT_MS,
      },
      { signal: options.signal },
    );
    if (response._tag === "err") {
      return undefined;
    }

    const payload = parseJsonBody(response.value.bodyText);
    if (payload._tag === "err") {
      return undefined;
    }
    return exaApiContentsPayloadSchema.safeParse(payload.value).data?.results[0].text;
  }
}
