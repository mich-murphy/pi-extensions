import type { JsonValue } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer } from "effect";
import { Type } from "typebox";
import type { FetchPageResult } from "./fetch-page";
import { WEB_FETCH_FORMATS } from "./settings";
import { writeTempTextFile } from "./temp";
import type { OutputStoreError } from "./temp";
import type {
  NormalizedSearchResult,
  PublicHttpUrl,
  WebFetchDetails,
  WebFetchFormat,
  WebSearchDetails,
} from "./types";

/** Expected failures of the tool output store. */
export type ToolOutputStoreError = OutputStoreError;

/** Persistence port for oversized tool output. */
export class ToolOutputStore extends Context.Service<
  ToolOutputStore,
  {
    /** Write full tool output to a new private file and return its path. */
    readonly writeTextFile: (
      prefix: string,
      fileName: string,
      content: string,
    ) => Effect.Effect<string, ToolOutputStoreError>;
  }
>()("pi-web-tools/tool-output/ToolOutputStore") {
  /** The live store: private temporary text files. */
  static readonly layer = Layer.succeed(
    ToolOutputStore,
    ToolOutputStore.of({
      writeTextFile: (prefix, fileName, content) =>
        writeTempTextFile(prefix, fileName, content).pipe(
          Effect.withSpan("ToolOutputStore.writeTextFile"),
        ),
    }),
  );
}

/**
 * Replace every occurrence of each secret in text with a fixed placeholder.
 * Applied to all tool output and error messages as defense in depth: provider
 * responses should never contain API keys, but a compromised or buggy endpoint
 * must not be able to reflect credentials back into the session transcript.
 */
export function redactSecrets(input: string, secrets: readonly (string | undefined)[]): string {
  const unique = [
    ...new Set(secrets.filter((secret): secret is string => secret !== undefined && secret !== "")),
  ];
  if (unique.length === 0) {
    return input;
  }
  // Match the original input once: longest alternatives win, and replacements are never rescanned.
  const pattern = unique
    .toSorted((a, b) => b.length - a.length)
    .map((secret) => secret.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`))
    .join("|");
  return input.replaceAll(new RegExp(pattern, "gu"), () => "[redacted]");
}

/** Pi text content item. */
export type PiTextContent = { readonly type: "text"; readonly text: string };
/** Pi image content item. */
export type PiImageContent = {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
};

/** Minimal shape of a pi tool result. */
export type PiToolResult<Details> = {
  readonly content: (PiTextContent | PiImageContent)[];
  readonly details: Details;
  /** Machine-readable result matching the tool's output schema, redacted like the text. */
  readonly structuredContent: JsonValue;
};

/** Most bytes of page text carried in webfetch `structuredContent`, like Pi's bash tool. */
export const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;

/**
 * Output schema of webfetch. Text fields are snake_case like Pi's bash tool; the image variant
 * matches the `read` tool so codemode's `image()` accepts it. Descriptions are left out so the
 * type stays short in tool descriptions.
 */
export const WEB_FETCH_OUTPUT_SCHEMA = Type.Union([
  Type.Object({
    url: Type.String(),
    status: Type.Optional(Type.Number()),
    mime_type: Type.Optional(Type.String()),
    format: Type.Union(WEB_FETCH_FORMATS.map((format) => Type.Literal(format))),
    bytes: Type.Number(),
    content: Type.String(),
    truncated: Type.Boolean(),
    full_output_path: Type.Optional(Type.String()),
    via: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal("image"),
    data: Type.String(),
    mimeType: Type.String(),
    note: Type.String(),
  }),
]);

/** Output schema of websearch. */
export const WEB_SEARCH_OUTPUT_SCHEMA = Type.Object({
  query: Type.String(),
  provider: Type.String(),
  results: Type.Array(
    Type.Object({
      title: Type.String(),
      url: Type.String(),
      snippet: Type.Optional(Type.String()),
      published_at: Type.Optional(Type.String()),
      source: Type.Optional(Type.String()),
      score: Type.Optional(Type.Number()),
    }),
  ),
});

/** Cut text to at most maxBytes of UTF-8 without splitting a character. */
function limitUtf8Bytes(
  text: string,
  maxBytes: number,
): { readonly content: string; readonly truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return { content: text, truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && ((bytes.at(end) ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return { content: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

/** Builds structured content once the spill path (if any) is known. */
type StructureOutput = (fullOutputPath: string | undefined) => JsonValue;

function fetchTextStructure(page: {
  readonly url: string;
  readonly format: WebFetchFormat;
  readonly bytes: number;
  readonly text: string;
  readonly status?: number;
  readonly mimeType?: string;
  readonly via?: string;
}): StructureOutput {
  return (fullOutputPath) => {
    const { content, truncated } = limitUtf8Bytes(page.text, STRUCTURED_OUTPUT_MAX_BYTES);
    return {
      url: page.url,
      ...(page.status === undefined ? {} : { status: page.status }),
      ...(page.mimeType === undefined ? {} : { mime_type: page.mimeType }),
      format: page.format,
      bytes: page.bytes,
      content,
      truncated,
      ...(fullOutputPath === undefined ? {} : { full_output_path: fullOutputPath }),
      ...(page.via === undefined ? {} : { via: page.via }),
    };
  };
}

/** Format normalized search results as URL-forward text for LLM consumption. */
export function formatSearchResults(
  query: string,
  results: readonly NormalizedSearchResult[],
): string {
  if (results.length === 0) {
    return `Search results for: ${query}\n\nNo results found.`;
  }

  const lines = [`Search results for: ${query}`, ""];
  for (const [index, result] of results.entries()) {
    lines.push(`${index + 1}. ${result.title}`, `   URL: ${result.url}`);
    if (result.publishedAt !== undefined && result.publishedAt !== "") {
      lines.push(`   Published: ${result.publishedAt}`);
    }
    if (result.source !== undefined && result.source !== "") {
      lines.push(`   Source: ${result.source}`);
    }
    if (typeof result.score === "number") {
      lines.push(`   Score: ${result.score}`);
    }
    if (result.snippet !== undefined && result.snippet !== "") {
      lines.push(`   Snippet: ${result.snippet}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** Truncation state recorded in the details of every text tool result. */
type TruncationDetails = {
  readonly truncated: boolean;
  readonly fullOutputPath?: string | undefined;
};

/** Markdown a fetch provider retrieved after the direct fetch was blocked or unusable. */
export type ProviderFetchedPage = {
  /** The fetch provider that retrieved the page; the URL was shared with it. */
  readonly provider: string;
  readonly url: PublicHttpUrl;
  readonly markdown: string;
};

/** Project a directly fetched page into a pi tool result, truncating and spilling large output. */
export function projectFetchResult(
  result: FetchPageResult,
  options: {
    readonly store: ToolOutputStore["Service"];
    readonly secrets: readonly (string | undefined)[];
  },
): Effect.Effect<PiToolResult<WebFetchDetails>, ToolOutputStoreError> {
  const { meta, body } = result;
  const safeMeta = {
    ...meta,
    requestedUrl: redactSecrets(meta.requestedUrl, options.secrets),
    finalUrl: redactSecrets(meta.finalUrl, options.secrets),
    mime: redactSecrets(meta.mime, options.secrets),
    contentType: redactSecrets(meta.contentType, options.secrets),
    ...(meta.charset === undefined
      ? {}
      : { charset: redactSecrets(meta.charset, options.secrets) }),
  };
  if (body._tag === "Image") {
    const note = redactSecrets(
      `Fetched image from ${meta.finalUrl} (${meta.mime || "image"}, ${formatSize(meta.bytes)})`,
      options.secrets,
    );
    const data = body.data.toString("base64");
    return Effect.succeed({
      content: [
        { type: "text", text: note },
        { type: "image", data, mimeType: safeMeta.mime },
      ],
      details: { ...safeMeta, image: true },
      structuredContent: { type: "image", data, mimeType: safeMeta.mime, note },
    });
  }

  const text = redactSecrets(body.text, options.secrets);
  return projectTextOutput<WebFetchDetails>({
    output: text,
    details: {
      ...safeMeta,
      decoder: redactSecrets(body.decoder, options.secrets),
    },
    structure: fetchTextStructure({
      url: safeMeta.finalUrl,
      format: meta.format,
      bytes: meta.bytes,
      text,
      status: meta.status,
      mimeType: safeMeta.mime,
    }),
    store: options.store,
    tempPrefix: "pi-webfetch-",
  });
}

/**
 * Project provider-fetched markdown into a pi tool result, prefixed with a note that says where it
 * came from. Details carry only what the rescue knows: no final URL, HTTP status, or content type.
 */
export function projectProviderFetchedPage(
  page: ProviderFetchedPage,
  options: {
    readonly store: ToolOutputStore["Service"];
    readonly secrets: readonly (string | undefined)[];
  },
): Effect.Effect<PiToolResult<WebFetchDetails>, ToolOutputStoreError> {
  const note = `[Direct fetch was blocked or unusable; content retrieved via ${page.provider} — the URL was shared with that provider]`;
  const requestedUrl = redactSecrets(page.url, options.secrets);
  const bytes = Buffer.byteLength(page.markdown, "utf8");
  const via = redactSecrets(page.provider, options.secrets);
  return projectTextOutput<WebFetchDetails>({
    output: redactSecrets(`${note}\n\n${page.markdown}`, options.secrets),
    details: { requestedUrl, format: "markdown", bytes, via },
    structure: fetchTextStructure({
      url: requestedUrl,
      format: "markdown",
      bytes,
      text: redactSecrets(page.markdown, options.secrets),
      via,
    }),
    store: options.store,
    tempPrefix: "pi-webfetch-",
  });
}

/** Project search results into a pi tool result, truncating and spilling large output. */
export function projectSearchResults(
  search: {
    readonly query: string;
    readonly results: readonly NormalizedSearchResult[];
    readonly details: Omit<WebSearchDetails, "truncated" | "fullOutputPath">;
  },
  options: {
    readonly store: ToolOutputStore["Service"];
    readonly secrets: readonly (string | undefined)[];
  },
): Effect.Effect<PiToolResult<WebSearchDetails>, ToolOutputStoreError> {
  return projectTextOutput({
    output: redactSecrets(formatSearchResults(search.query, search.results), options.secrets),
    details: {
      ...search.details,
      query: redactSecrets(search.details.query, options.secrets),
    },
    structure: () => searchStructure(search, options.secrets),
    store: options.store,
    tempPrefix: "pi-websearch-",
  });
}

function searchStructure(
  search: {
    readonly query: string;
    readonly results: readonly NormalizedSearchResult[];
    readonly details: { readonly provider: string };
  },
  secrets: readonly (string | undefined)[],
): JsonValue {
  const redact = (input: string) => redactSecrets(input, secrets);
  return {
    query: redact(search.query),
    provider: redact(search.details.provider),
    results: search.results.map((result) => ({
      title: redact(result.title),
      url: redact(result.url),
      ...(result.snippet === undefined ? {} : { snippet: redact(result.snippet) }),
      ...(result.publishedAt === undefined ? {} : { published_at: redact(result.publishedAt) }),
      ...(result.source === undefined ? {} : { source: redact(result.source) }),
      ...(result.score === undefined ? {} : { score: result.score }),
    })),
  };
}

function projectTextOutput<Details>({
  output,
  details,
  structure,
  store,
  tempPrefix,
}: {
  readonly output: string;
  readonly details: Details;
  readonly structure: StructureOutput;
  readonly store: ToolOutputStore["Service"];
  readonly tempPrefix: string;
}): Effect.Effect<PiToolResult<Details & TruncationDetails>, ToolOutputStoreError> {
  const truncation = truncateHead(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });

  if (!truncation.truncated) {
    return Effect.succeed({
      content: [{ type: "text", text: truncation.content }],
      details: { ...details, truncated: false },
      structuredContent: structure(undefined),
    });
  }

  return store.writeTextFile(tempPrefix, "output.txt", output).pipe(
    Effect.map((fullOutputPath) => {
      const omittedLines = truncation.totalLines - truncation.outputLines;
      const omittedBytes = truncation.totalBytes - truncation.outputBytes;
      let text = truncation.content;
      text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
      text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
      text += ` ${omittedLines} lines (${formatSize(omittedBytes)}) omitted.`;
      text += ` Full output saved to: ${fullOutputPath}]`;
      return {
        content: [{ type: "text", text }],
        details: { ...details, truncated: true, fullOutputPath },
        structuredContent: structure(fullOutputPath),
      };
    }),
  );
}
