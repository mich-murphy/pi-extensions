import { Redacted, Result } from "effect";

/** Extension name used for temp files and status surfaces. */
export const WEB_TOOLS_EXTENSION_NAME = "pi-web-tools";
/** Version reported to provider endpoints (for example MCP clientInfo). */
export const WEB_TOOLS_VERSION = "0.1.0";

/** A public HTTP(S) URL accepted by web-tools. */
export type PublicHttpUrl = string & { readonly __brand: "PublicHttpUrl" };

/** A non-empty, trimmed search query. */
export type SearchQuery = string & { readonly __brand: "SearchQuery" };

/** Output formats supported by the webfetch tool. */
export type WebFetchFormat = "markdown" | "text" | "html";
/** Search providers supported by the websearch tool. */
export type SearchProviderName = "exa" | "parallel" | "brave";
/** Coarse classification of a fetched response body. */
export type ContentKind = "html" | "text" | "raster-image" | "svg" | "binary";

/** Failures parsing boundary input into a public HTTP(S) URL. */
export type ParsePublicHttpUrlError =
  | { readonly _tag: "EmptyUrl" }
  | { readonly _tag: "UnsupportedUrlProtocol"; readonly protocol?: string }
  | { readonly _tag: "InvalidUrl"; readonly input: Redacted.Redacted }
  | { readonly _tag: "UrlCredentialsUnsupported"; readonly url: Redacted.Redacted };

/** Failures parsing boundary input into a search query. */
export type ParseSearchQueryError = { readonly _tag: "EmptySearchQuery" };

/** A provider-agnostic search result. */
export type NormalizedSearchResult = {
  readonly title: string;
  readonly url: PublicHttpUrl;
  readonly snippet?: string | undefined;
  readonly publishedAt?: string | undefined;
  readonly source?: string | undefined;
  readonly score?: number | undefined;
};

/**
 * Structured details attached to a webfetch tool result. Response fields a provider-side rescue
 * cannot observe (final URL, status, mime, content type, charset, decoder) are absent when `via`
 * is set.
 */
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
  readonly fullOutputPath?: string | undefined;
  /** Set when content came from a provider-side fetch instead of a direct request. */
  readonly via?: string | undefined;
};

/** Structured details attached to a websearch tool result. */
export type WebSearchDetails = {
  readonly query: string;
  readonly maxResults: number;
  readonly provider: SearchProviderName;
  readonly attemptedProviders: readonly SearchProviderName[];
  readonly resultCount: number;
  readonly truncated?: boolean | undefined;
  readonly fullOutputPath?: string | undefined;
};

/** Parse and normalize a public HTTP(S) URL from boundary input. */
export function parsePublicHttpUrl(
  input: string,
): Result.Result<PublicHttpUrl, ParsePublicHttpUrlError> {
  const trimmed = input.trim();
  if (!trimmed) {
    return Result.fail({ _tag: "EmptyUrl" });
  }

  const schemeMatch = /^(?<scheme>[a-z][a-z0-9+.-]*):/iu.exec(trimmed);
  const protocol = schemeMatch?.groups?.scheme?.toLowerCase();
  const normalized = trimmed.toLowerCase();
  if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
    if (protocol !== undefined) {
      return Result.fail({ _tag: "UnsupportedUrlProtocol", protocol: `${protocol}:` });
    }
    return Result.fail({ _tag: "UnsupportedUrlProtocol" });
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return Result.fail({ _tag: "InvalidUrl", input: Redacted.make(trimmed) });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Result.fail({ _tag: "UnsupportedUrlProtocol", protocol: url.protocol });
  }

  if (url.username || url.password) {
    return Result.fail({ _tag: "UrlCredentialsUnsupported", url: Redacted.make(url.toString()) });
  }

  // A parsed URL serializes to a string that parses back to itself, so this check always passes.
  const href = url.toString();
  return isPublicHttpUrl(href)
    ? Result.succeed(href)
    : Result.fail({ _tag: "InvalidUrl", input: Redacted.make(trimmed) });
}

/**
 * Returns true when a string is a URL in the form parsePublicHttpUrl produces: it parses, uses
 * http or https, carries no credentials, and is already serialized.
 */
export function isPublicHttpUrl(value: string): value is PublicHttpUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === "" &&
    url.toString() === value
  );
}

/** Parse and trim a non-empty search query from boundary input. */
export function parseSearchQuery(input: string): Result.Result<SearchQuery, ParseSearchQueryError> {
  const query = input.trim();
  return isSearchQuery(query) ? Result.succeed(query) : Result.fail({ _tag: "EmptySearchQuery" });
}

function isSearchQuery(value: string): value is SearchQuery {
  return value !== "" && value.trim() === value;
}

/** Placeholder shown instead of a URL that carries credentials (matches Redacted's projection). */
const REDACTED_DISPLAY = "<redacted>";

/** Format URL-like UI text without exposing URL userinfo credentials. */
export function redactUrlCredentialsForDisplay(input: unknown): string {
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
