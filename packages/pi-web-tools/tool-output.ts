import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { FetchPageResult } from "./fetch-page";
import { redactSecrets } from "./redacted";
import { err, ok } from "./result";
import type { Result } from "./result";
import { writeTempTextFile } from "./temp";
import type {
  NormalizedSearchResult,
  PublicHttpUrl,
  WebFetchDetails,
  WebSearchDetails,
} from "./types";

/** Persistence port for oversized tool output. */
export type ToolOutputStore = {
  readonly writeTextFile: (
    prefix: string,
    fileName: string,
    content: string,
  ) => Promise<Result<string, ToolOutputStoreError>>;
};

/** Expected failures of the tool output store. */
export type ToolOutputStoreError = { readonly _tag: "TempFileWriteFailed" };

/** Temp-file backed tool output store with private permissions. */
export const tempFileToolOutputStore: ToolOutputStore = {
  /** Write full tool output to a private temporary text file. */
  async writeTextFile(prefix, fileName, content) {
    try {
      return ok(await writeTempTextFile(prefix, fileName, content));
    } catch {
      return err({ _tag: "TempFileWriteFailed" });
    }
  },
};

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
};

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
export async function projectFetchResult(
  result: FetchPageResult,
  options: { readonly store: ToolOutputStore; readonly secrets: readonly (string | undefined)[] },
): Promise<Result<PiToolResult<WebFetchDetails>, ToolOutputStoreError>> {
  const { meta, body } = result;
  if (body._tag === "Image") {
    return ok({
      content: [
        {
          type: "text",
          text: `Fetched image from ${meta.finalUrl} (${meta.mime || "image"}, ${formatSize(meta.bytes)})`,
        },
        { type: "image", data: body.data.toString("base64"), mimeType: meta.mime },
      ],
      details: { ...meta, image: true },
    });
  }

  return projectTextOutput<WebFetchDetails>({
    output: redactSecrets(body.text, options.secrets),
    details: { ...meta, decoder: body.decoder },
    store: options.store,
    tempPrefix: "pi-webfetch-",
  });
}

/**
 * Project provider-fetched markdown into a pi tool result, prefixed with a note that says where it
 * came from. Details carry only what the rescue knows: no final URL, HTTP status, or content type.
 */
export async function projectProviderFetchedPage(
  page: ProviderFetchedPage,
  options: { readonly store: ToolOutputStore; readonly secrets: readonly (string | undefined)[] },
): Promise<Result<PiToolResult<WebFetchDetails>, ToolOutputStoreError>> {
  const note = `[Direct fetch was blocked or unusable; content retrieved via ${page.provider} — the URL was shared with that provider]`;
  return projectTextOutput<WebFetchDetails>({
    output: redactSecrets(`${note}\n\n${page.markdown}`, options.secrets),
    details: {
      requestedUrl: page.url,
      format: "markdown",
      bytes: Buffer.byteLength(page.markdown, "utf8"),
      via: page.provider,
    },
    store: options.store,
    tempPrefix: "pi-webfetch-",
  });
}

/** Project search results into a pi tool result, truncating and spilling large output. */
export async function projectSearchResults(
  search: {
    readonly query: string;
    readonly results: readonly NormalizedSearchResult[];
    readonly details: Omit<WebSearchDetails, "truncated" | "fullOutputPath">;
  },
  options: { readonly store: ToolOutputStore; readonly secrets: readonly (string | undefined)[] },
): Promise<Result<PiToolResult<WebSearchDetails>, ToolOutputStoreError>> {
  return projectTextOutput({
    output: redactSecrets(formatSearchResults(search.query, search.results), options.secrets),
    details: search.details,
    store: options.store,
    tempPrefix: "pi-websearch-",
  });
}

/** Truncate text output for the model, spilling the full text to the store when it is too large. */
async function projectTextOutput<Details>({
  output,
  details,
  store,
  tempPrefix,
}: {
  readonly output: string;
  readonly details: Details;
  readonly store: ToolOutputStore;
  readonly tempPrefix: string;
}): Promise<Result<PiToolResult<Details & TruncationDetails>, ToolOutputStoreError>> {
  const truncation = truncateHead(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });

  if (!truncation.truncated) {
    return ok({
      content: [{ type: "text", text: truncation.content }],
      details: { ...details, truncated: false },
    });
  }

  const fullOutputPath = await store.writeTextFile(tempPrefix, "output.txt", output);
  if (fullOutputPath._tag === "err") {
    return fullOutputPath;
  }

  const omittedLines = truncation.totalLines - truncation.outputLines;
  const omittedBytes = truncation.totalBytes - truncation.outputBytes;
  let text = truncation.content;
  text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
  text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
  text += ` ${omittedLines} lines (${formatSize(omittedBytes)}) omitted.`;
  text += ` Full output saved to: ${fullOutputPath.value}]`;

  return ok({
    content: [{ type: "text", text }],
    details: { ...details, truncated: true, fullOutputPath: fullOutputPath.value },
  });
}
