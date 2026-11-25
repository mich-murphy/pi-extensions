import { Redacted, Result, Schema } from "effect";

export const WEB_EXTENSION_NAME = "pi-web";
export const WEB_VERSION = "0.1.0";

const NormalizedPublicHttpUrl = Schema.String.pipe(Schema.brand("PublicHttpUrl"));

export type PublicHttpUrl = typeof NormalizedPublicHttpUrl.Type;

export type SearchQuery = string & { readonly __brand: "SearchQuery" };

export type WebFetchFormat = "markdown" | "text" | "html";
export type SearchProviderName = "exa" | "parallel" | "brave";
export type ContentKind = "html" | "text" | "raster-image" | "svg" | "binary";

const EmptyUrl = Schema.TaggedStruct("EmptyUrl", {});
const UnsupportedUrlProtocol = Schema.TaggedStruct("UnsupportedUrlProtocol", {
  protocol: Schema.optionalKey(Schema.String),
});
const InvalidUrl = Schema.TaggedStruct("InvalidUrl", { input: Schema.Redacted(Schema.String) });
const UrlCredentialsUnsupported = Schema.TaggedStruct("UrlCredentialsUnsupported", {
  url: Schema.Redacted(Schema.String),
});

export const ParsePublicHttpUrlError = Schema.Union([
  EmptyUrl,
  UnsupportedUrlProtocol,
  InvalidUrl,
  UrlCredentialsUnsupported,
]);
export type ParsePublicHttpUrlError = typeof ParsePublicHttpUrlError.Type;

const EmptySearchQuery = Schema.TaggedStruct("EmptySearchQuery", {});

export type ParseSearchQueryError = typeof EmptySearchQuery.Type;

export type NormalizedSearchResult = {
  readonly title: string;
  readonly url: PublicHttpUrl;
  readonly snippet?: string | undefined;
  readonly publishedAt?: string | undefined;
  readonly source?: string | undefined;
  readonly score?: number | undefined;
};

export type WebFetchDetails = {
  readonly requestedUrl: string;
  readonly finalUrl?: string | undefined;
  readonly format: WebFetchFormat;
  readonly status?: number | undefined;
  readonly mime?: string | undefined;
  readonly contentType?: string | undefined;
  readonly charset?: string | undefined;
  readonly decoder?: string | undefined;
  readonly bytes: number;
  readonly image?: boolean | undefined;
  readonly truncated?: boolean | undefined;
  readonly responseTruncated?: boolean | undefined;
  readonly downloadLimitBytes?: number | undefined;
  readonly fullOutputPath?: string | undefined;
  readonly via?: string | undefined;
};

export type WebSearchDetails = {
  readonly query: string;
  readonly maxResults: number;
  readonly provider: SearchProviderName;
  readonly attemptedProviders: readonly SearchProviderName[];
  readonly resultCount: number;
  readonly truncated?: boolean | undefined;
  readonly fullOutputPath?: string | undefined;
};

export function parsePublicHttpUrl(
  input: string,
): Result.Result<PublicHttpUrl, ParsePublicHttpUrlError> {
  const trimmed = input.trim();
  if (!trimmed) {
    return Result.fail(EmptyUrl.make({}));
  }

  const schemeMatch = /^(?<scheme>[a-z][a-z0-9+.-]*):/iu.exec(trimmed);
  const protocol = schemeMatch?.groups?.scheme?.toLowerCase();
  const normalized = trimmed.toLowerCase();
  if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
    if (protocol !== undefined) {
      return Result.fail(UnsupportedUrlProtocol.make({ protocol: `${protocol}:` }));
    }
    return Result.fail(UnsupportedUrlProtocol.make({}));
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return Result.fail(InvalidUrl.make({ input: Redacted.make(trimmed) }));
  }

  if (url.username || url.password) {
    return Result.fail(UrlCredentialsUnsupported.make({ url: Redacted.make(url.toString()) }));
  }

  return Result.succeed(NormalizedPublicHttpUrl.make(url.toString()));
}

export const isPublicHttpUrl = Schema.is(
  NormalizedPublicHttpUrl.check(
    Schema.makeFilter((value) => {
      const parsed = parsePublicHttpUrl(value);
      return Result.isSuccess(parsed) && parsed.success === value;
    }),
  ),
);

export function parseSearchQuery(input: string): Result.Result<SearchQuery, ParseSearchQueryError> {
  const query = input.trim();
  return isSearchQuery(query) ? Result.succeed(query) : Result.fail(EmptySearchQuery.make({}));
}

function isSearchQuery(value: string): value is SearchQuery {
  return value !== "" && value.trim() === value;
}

const REDACTED_DISPLAY = "<redacted>";

export function redactUrlCredentialsForDisplay(input: string | undefined): string {
  const raw = String(input);
  const trimmed = raw.trim();
  if (!trimmed) {
    return raw;
  }

  try {
    const url = new URL(trimmed);
    if (url.username || url.password) {
      return REDACTED_DISPLAY;
    }
    return url.toString();
  } catch {
    return looksLikeCredentialedAbsoluteUrl(trimmed) ? REDACTED_DISPLAY : raw;
  }
}

function looksLikeCredentialedAbsoluteUrl(input: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]*@/iu.test(input);
}
