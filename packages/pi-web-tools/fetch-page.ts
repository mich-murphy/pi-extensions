import { htmlToMarkdown, htmlToText, isPoorMarkdownConversion } from "./html";
import {
  decodeTextBuffer,
  type PublicWebClient,
  type PublicWebError,
  parseContentType,
} from "./network";
import { err, ok, type Result } from "./result";
import type { PublicHttpUrl, WebFetchFormat } from "./types";

/** Browser-like default user agent for direct fetches. */
const WEBFETCH_DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
/** Fallback user agent used to retry Cloudflare challenge responses. */
const WEBFETCH_FALLBACK_USER_AGENT = "pi-web-tools";

/** Input to the fetch-page service. */
export interface FetchPageInput {
  readonly url: PublicHttpUrl;
  readonly format: WebFetchFormat;
}

/** Metadata shared by text and image results: the requested format plus what the response declared. */
export interface FetchPageMeta {
  readonly requestedUrl: PublicHttpUrl;
  readonly finalUrl: PublicHttpUrl;
  readonly format: WebFetchFormat;
  readonly status: number;
  readonly mime: string;
  readonly contentType: string;
  readonly charset?: string | undefined;
  readonly bytes: number;
}

/** A successfully fetched page: response metadata plus its converted text or raw raster image. */
export interface FetchPageResult {
  readonly meta: FetchPageMeta;
  readonly body:
    | {
        readonly _tag: "Text";
        /** The response's content kind; raster images are the Image body, binary is an error. */
        readonly kind: "html" | "text" | "svg";
        readonly text: string;
        readonly decoder: string;
      }
    | { readonly _tag: "Image"; readonly data: Buffer };
}

/** Expected failures of the fetch-page service. */
export type FetchPageError =
  | PublicWebError
  | { readonly _tag: "UnsupportedBinaryContent"; readonly mime?: string | undefined }
  | { readonly _tag: "HtmlConversionFailed" };

/** Application service: fetch one public page and project it to the requested representation. */
export class FetchPage {
  constructor(private readonly publicWeb: PublicWebClient) {}

  /** Fetch a public web resource and convert it to the requested content representation. */
  async fetch(
    input: FetchPageInput,
    options: {
      readonly signal?: AbortSignal | undefined;
      readonly maxRedirects: number;
      readonly maxResponseBytes: number;
      readonly blockPrivateHosts: boolean;
    },
  ): Promise<Result<FetchPageResult, FetchPageError>> {
    const response = await this.publicWeb.get(
      {
        url: input.url,
        accept: getAcceptHeader(input.format),
        userAgent: WEBFETCH_DEFAULT_USER_AGENT,
        fallbackUserAgent: WEBFETCH_FALLBACK_USER_AGENT,
        maxRedirects: options.maxRedirects,
        maxResponseBytes: options.maxResponseBytes,
        blockPrivateHosts: options.blockPrivateHosts,
      },
      { signal: options.signal },
    );
    if (response._tag === "err") {
      return response;
    }

    const parsedContentType = parseContentType(response.value.headers.get("content-type"));
    if (parsedContentType.kind === "binary") {
      return err({ _tag: "UnsupportedBinaryContent", mime: parsedContentType.mime || undefined });
    }

    const meta: FetchPageMeta = {
      requestedUrl: response.value.requestedUrl,
      finalUrl: response.value.finalUrl,
      format: input.format,
      status: response.value.status,
      mime: parsedContentType.mime,
      contentType: parsedContentType.contentType,
      charset: parsedContentType.charset,
      bytes: response.value.body.byteLength,
    };
    if (parsedContentType.kind === "raster-image") {
      return ok({ meta, body: { _tag: "Image", data: response.value.body } });
    }

    const decoded = decodeTextBuffer(response.value.body, parsedContentType.charset);
    const converted = convertText(
      decoded.text,
      response.value.finalUrl,
      parsedContentType.kind,
      input.format,
    );
    if (converted._tag === "err") {
      return converted;
    }

    return ok({
      meta,
      body: {
        _tag: "Text",
        kind: parsedContentType.kind,
        text: converted.value,
        decoder: decoded.decoder,
      },
    });
  }
}

/** Return the Accept header value for a webfetch format. */
export function getAcceptHeader(format: WebFetchFormat): string {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, application/xhtml+xml;q=0.6, */*;q=0.1";
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, application/xhtml+xml;q=0.7, */*;q=0.1";
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
  }
}

function convertText(
  text: string,
  baseUrl: PublicHttpUrl,
  kind: "html" | "text" | "svg",
  format: WebFetchFormat,
): Result<string, FetchPageError> {
  try {
    if (kind === "html" && format === "markdown") {
      const markdown = htmlToMarkdown(text, baseUrl);
      return ok(isPoorMarkdownConversion(markdown) ? htmlToText(text, baseUrl) : markdown);
    }
    if (kind === "html" && format === "text") {
      return ok(htmlToText(text, baseUrl));
    }
    return ok(text);
  } catch {
    return err({ _tag: "HtmlConversionFailed" });
  }
}
