import { Context, Data, Effect, Layer, Result, Schema } from "effect";
import { absurd } from "effect/Function";
import type { DomainPolicy } from "./domain-policy";
import { htmlToMarkdownWithTextFallback, htmlToText } from "./html";
import type { HtmlConversionError } from "./html-conversion";
import { decodeTextBuffer, parseContentType, PublicWebClient } from "./network";
import type { PublicWebError, PublicWebResponse } from "./network";
import { withSafeSpan } from "./telemetry";
import type { PublicHttpUrl, WebFetchFormat } from "./types";

const WEBFETCH_DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const WEBFETCH_FALLBACK_USER_AGENT = "pi-web";

type FetchPageInput = {
  readonly url: PublicHttpUrl;
  readonly format: WebFetchFormat;
};

export type FetchPageMeta = {
  readonly requestedUrl: string;
  readonly finalUrl: PublicHttpUrl;
  readonly format: WebFetchFormat;
  readonly status: number;
  readonly mime: string;
  readonly contentType: string;
  readonly charset?: string | undefined;
  readonly bytes: number;
  readonly responseTruncated?: true;
};

export type FetchPageBody = Data.TaggedEnum<{
  Text: {
    readonly kind: "html" | "text" | "svg";
    readonly text: string;
    readonly decoder: string;
  };
  Image: { readonly data: Readonly<Buffer> };
}>;

export const FetchPageBody = Data.taggedEnum<FetchPageBody>();

export type FetchPageResult = {
  readonly meta: FetchPageMeta;
  readonly body: FetchPageBody;
};

export class UnsupportedBinaryContent extends Schema.TaggedError<UnsupportedBinaryContent>()(
  "UnsupportedBinaryContent",
  {
    mime: Schema.String,
  },
) {
  override get message(): string {
    if (this.mime === "application/pdf") {
      return "webfetch cannot extract PDF text. Use an HTML/text version or ask the user for the text; retrying the same PDF will not convert it.";
    }
    const label = ["application/zip", "application/octet-stream"].includes(this.mime)
      ? ` (${this.mime})`
      : "";
    return `Unsupported binary content${label}. Try a more text-oriented URL.`;
  }
}

export type FetchPageError = PublicWebError | UnsupportedBinaryContent | HtmlConversionError;

type FetchPageOptions = {
  readonly maxRedirects: number;
  readonly maxResponseBytes: number;
  readonly blockPrivateHosts: boolean;
  readonly domainPolicy: DomainPolicy;
};

export class FetchPage extends Context.Service<
  FetchPage,
  {
    readonly fetch: (
      input: { readonly url: PublicHttpUrl; readonly format: WebFetchFormat },
      options: {
        readonly maxRedirects: number;
        readonly maxResponseBytes: number;
        readonly blockPrivateHosts: boolean;
        readonly domainPolicy: DomainPolicy;
      },
    ) => Effect.Effect<FetchPageResult, FetchPageError>;
  }
>()("pi-web/fetch-page/FetchPage") {
  static readonly layer = Layer.effect(
    FetchPage,
    Effect.gen(function* () {
      const publicWeb = yield* PublicWebClient;
      const fetch = Effect.fnUntraced(
        function* (
          input: FetchPageInput,
          options: FetchPageOptions,
        ): Effect.fn.Return<FetchPageResult, FetchPageError> {
          const response = yield* publicWeb.get({
            url: input.url,
            accept: getAcceptHeader(input.format),
            userAgent: WEBFETCH_DEFAULT_USER_AGENT,
            fallbackUserAgent: WEBFETCH_FALLBACK_USER_AGENT,
            maxRedirects: options.maxRedirects,
            maxResponseBytes: options.maxResponseBytes,
            allowPartialText: true,
            blockPrivateHosts: options.blockPrivateHosts,
            domainPolicy: options.domainPolicy,
          });
          return yield* Effect.fromResult(projectResponse(response, input.format));
        },
        (effect) => withSafeSpan("FetchPage.fetch", effect, (error) => ({ type: error._tag })),
      );
      return FetchPage.of({ fetch });
    }),
  );
}

function projectResponse(
  response: PublicWebResponse,
  format: WebFetchFormat,
): Result.Result<FetchPageResult, UnsupportedBinaryContent | HtmlConversionError> {
  const parsedContentType = parseContentType(response.headers.get("content-type"));
  if (parsedContentType.kind === "binary") {
    return Result.fail(new UnsupportedBinaryContent({ mime: parsedContentType.mime }));
  }

  const meta: Omit<FetchPageMeta, "responseTruncated"> & { responseTruncated?: true } = {
    requestedUrl: response.requestedUrl,
    finalUrl: response.finalUrl,
    format,
    status: response.status,
    mime: parsedContentType.mime,
    contentType: parsedContentType.contentType,
    charset: parsedContentType.charset,
    bytes: response.body.byteLength,
  };
  if (response.responseTruncated === true) {
    meta.responseTruncated = true;
  }
  if (parsedContentType.kind === "raster-image") {
    return Result.succeed({ meta, body: FetchPageBody.Image({ data: response.body }) });
  }

  const decoded = decodeTextBuffer(response.body, parsedContentType.charset, {
    partial: response.responseTruncated === true,
  });
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
    body: FetchPageBody.Text({
      kind: parsedContentType.kind,
      text: converted.success,
      decoder: decoded.decoder,
    }),
  });
}

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
