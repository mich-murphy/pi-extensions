import { Data, Effect, Result } from "effect";
import { absurd } from "effect/Function";
import { htmlToMarkdownWithTextFallback, htmlToText } from "./html";
import type { HtmlConversionError } from "./html-conversion";
import { decodeTextBuffer, parseContentType } from "./network";
import type { PublicWebClient, PublicWebError, PublicWebResponse } from "./network";
import type { PublicHttpUrl, WebFetchFormat } from "./types";

/** Browser-like default user agent for direct fetches. */
const WEBFETCH_DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
/** Fallback user agent used to retry Cloudflare challenge responses. */
const WEBFETCH_FALLBACK_USER_AGENT = "pi-web-tools";

/** Input to the fetch-page service. */
export type FetchPageInput = {
  readonly url: PublicHttpUrl;
  readonly format: WebFetchFormat;
};

/** Metadata shared by text and image results: the requested format plus what the response declared. */
export type FetchPageMeta = {
  readonly requestedUrl: PublicHttpUrl;
  readonly finalUrl: PublicHttpUrl;
  readonly format: WebFetchFormat;
  readonly status: number;
  readonly mime: string;
  readonly contentType: string;
  readonly charset?: string | undefined;
  readonly bytes: number;
};

/** A successfully fetched page: response metadata plus its converted text or raw raster image. */
export type FetchPageResult = {
  readonly meta: FetchPageMeta;
  readonly body:
    | {
        readonly _tag: "Text";
        /** The response's content kind; raster images are the Image body, binary is an error. */
        readonly kind: "html" | "text" | "svg";
        readonly text: string;
        readonly decoder: string;
      }
    | { readonly _tag: "Image"; readonly data: Readonly<Buffer> };
};

/** The response is binary content webfetch cannot represent as text or an image. */
export class UnsupportedBinaryContent extends Data.TaggedError("UnsupportedBinaryContent")<{
  /** The declared mime type; empty when the response declared none. */
  readonly mime: string;
}> {
  /** Safe user-facing description with the mime type when known. */
  override get message(): string {
    return `Unsupported binary content${this.mime === "" ? "" : ` (${this.mime})`}. Try a more text-oriented URL.`;
  }
}

/** Expected failures of the fetch-page service; every member has a safe `message`. */
export type FetchPageError = PublicWebError | UnsupportedBinaryContent | HtmlConversionError;

/** Application service: fetch one public page and project it to the requested representation. */
export class FetchPage {
  constructor(private readonly publicWeb: PublicWebClient) {}

  /** Fetch a public web resource and convert it to the requested content representation. */
  fetch(
    input: FetchPageInput,
    options: {
      readonly maxRedirects: number;
      readonly maxResponseBytes: number;
      readonly blockPrivateHosts: boolean;
    },
  ): Effect.Effect<FetchPageResult, FetchPageError> {
    return this.publicWeb
      .get({
        url: input.url,
        accept: getAcceptHeader(input.format),
        userAgent: WEBFETCH_DEFAULT_USER_AGENT,
        fallbackUserAgent: WEBFETCH_FALLBACK_USER_AGENT,
        maxRedirects: options.maxRedirects,
        maxResponseBytes: options.maxResponseBytes,
        blockPrivateHosts: options.blockPrivateHosts,
      })
      .pipe(
        Effect.flatMap((response) => Effect.fromResult(projectResponse(response, input.format))),
      );
  }
}

// The pure half of a fetch: classify the content type, then decode and convert the body.
function projectResponse(
  response: PublicWebResponse,
  format: WebFetchFormat,
): Result.Result<FetchPageResult, UnsupportedBinaryContent | HtmlConversionError> {
  const parsedContentType = parseContentType(response.headers.get("content-type"));
  if (parsedContentType.kind === "binary") {
    return Result.fail(new UnsupportedBinaryContent({ mime: parsedContentType.mime }));
  }

  const meta: FetchPageMeta = {
    requestedUrl: response.requestedUrl,
    finalUrl: response.finalUrl,
    format,
    status: response.status,
    mime: parsedContentType.mime,
    contentType: parsedContentType.contentType,
    charset: parsedContentType.charset,
    bytes: response.body.byteLength,
  };
  if (parsedContentType.kind === "raster-image") {
    return Result.succeed({ meta, body: { _tag: "Image", data: response.body } });
  }

  const decoded = decodeTextBuffer(response.body, parsedContentType.charset);
  const converted = convertText({
    text: decoded.text,
    baseUrl: response.finalUrl,
    kind: parsedContentType.kind,
    format,
  });
  if (Result.isFailure(converted)) {
    return Result.fail(converted.failure);
  }
  return Result.succeed({
    meta,
    body: {
      _tag: "Text",
      kind: parsedContentType.kind,
      text: converted.success,
      decoder: decoded.decoder,
    },
  });
}

// The Accept header for a webfetch format: the requested representation first, HTML as fallback.
function getAcceptHeader(format: WebFetchFormat): string {
  switch (format) {
    case "markdown": {
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, application/xhtml+xml;q=0.6, */*;q=0.1";
    }
    case "text": {
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, application/xhtml+xml;q=0.7, */*;q=0.1";
    }
    case "html": {
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
    }
    default: {
      return absurd(format);
    }
  }
}

function convertText({
  text,
  baseUrl,
  kind,
  format,
}: {
  readonly text: string;
  readonly baseUrl: PublicHttpUrl;
  readonly kind: "html" | "text" | "svg";
  readonly format: WebFetchFormat;
}): Result.Result<string, HtmlConversionError> {
  if (kind === "html" && format === "markdown") {
    return htmlToMarkdownWithTextFallback(text, baseUrl);
  }
  if (kind === "html" && format === "text") {
    return htmlToText(text, baseUrl);
  }
  return Result.succeed(text);
}
