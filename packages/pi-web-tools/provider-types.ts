import { Data, Result } from "effect";
import type { Effect } from "effect";
import { z } from "zod";
import { describeNetworkFailure } from "./network";
import { parsePublicHttpUrl } from "./types";
import type {
  NormalizedSearchResult,
  PublicHttpUrl,
  SearchProviderName,
  SearchQuery,
} from "./types";

/** A provider request failed at the network level (DNS, connection, TLS, or body stream). */
export class ProviderRequestFailed extends Data.TaggedError("ProviderRequestFailed")<{
  /** The provider host; messages name only this, never the URL. */
  readonly hostname: string;
  /** The underlying fetch or stream error, kept for local diagnosis only. */
  readonly cause?: unknown;
}> {
  /** Safe lower-case phrase for a "<provider>: <reason>" line, e.g. "could not resolve host x". */
  override get message(): string {
    return lowerInitial(describeNetworkFailure(this.cause, this.hostname));
  }
}

/** A provider call ran past its deadline. */
export class ProviderTimedOut extends Data.TaggedError("ProviderTimedOut")<{
  /** The deadline in whole seconds. */
  readonly timeoutSeconds: number;
}> {
  /** Safe lower-case phrase naming the deadline. */
  override get message(): string {
    return `timed out after ${this.timeoutSeconds}s`;
  }
}

/** A provider answered with a non-2xx status. */
export class ProviderStatusRejected extends Data.TaggedError("ProviderStatusRejected")<{
  /** The HTTP status code. */
  readonly status: number;
}> {
  /** Safe lower-case phrase naming the status. */
  override get message(): string {
    return `rejected (HTTP ${this.status})`;
  }
}

/** A provider response exceeded the byte cap. */
export class ProviderResponseTooLarge extends Data.TaggedError("ProviderResponseTooLarge") {
  /** Safe lower-case phrase. */
  override get message(): string {
    return "response too large";
  }
}

/** A provider response did not match the expected protocol or payload shape. */
export class ProviderProtocolInvalid extends Data.TaggedError("ProviderProtocolInvalid")<{
  /** What was wrong with the response, for local diagnosis. */
  readonly reason: string;
}> {
  /** Safe lower-case phrase; the reason stays out of user-facing text. */
  override get message(): string {
    return "returned an invalid response";
  }
}

/** The provider's tool reported an error (JSON-RPC error or an isError tool result). */
export class ProviderToolError extends Data.TaggedError("ProviderToolError")<{
  /** The provider's own error text: whitespace-collapsed, at most 200 chars, secrets redacted. */
  readonly detail: string;
}> {
  /** Safe lower-case phrase including the provider's detail when there is one. */
  override get message(): string {
    return this.detail === "" ? "reported an error" : `reported an error: ${this.detail}`;
  }
}

/**
 * Expected failures of a provider call over either transport (hosted MCP or REST API). Messages
 * are lower-case phrases meant to follow a "<provider>: " prefix.
 */
export type ProviderError =
  | ProviderRequestFailed
  | ProviderTimedOut
  | ProviderStatusRejected
  | ProviderResponseTooLarge
  | ProviderProtocolInvalid
  | ProviderToolError;

// Lower-case the first letter unless it starts an acronym such as "TLS".
function lowerInitial(text: string): string {
  const second = text.charAt(1);
  return second !== "" && second === second.toUpperCase() && second !== second.toLowerCase()
    ? text
    : text.charAt(0).toLowerCase() + text.slice(1);
}

/** Parse an untrusted provider response body as JSON. */
export function parseJsonBody(bodyText: string): Result.Result<unknown, ProviderProtocolInvalid> {
  try {
    return Result.succeed(JSON.parse(bodyText));
  } catch {
    return Result.fail(new ProviderProtocolInvalid({ reason: "Invalid JSON response" }));
  }
}

/**
 * Array schema that drops items failing `item`, or mapped to undefined by it,
 * so one malformed provider record never sinks the response.
 */
export function lenientArray<T>(item: z.ZodType<T>) {
  return z
    .array(item.optional().catch(undefined))
    .transform((items) =>
      items.filter((entry): entry is Exclude<T, undefined> => entry !== undefined),
    );
}

/** Untrusted provider text, trimmed; blank, missing, or non-string values read as undefined. */
export const optionalTextSchema = z
  .string()
  .transform((value) => value.trim() || undefined)
  .optional()
  .catch(undefined);

/** Untrusted provider URL, accepted only when it parses as a public HTTP(S) URL. */
export const publicHttpUrlSchema = z.string().transform((value, ctx) => {
  const parsed = parsePublicHttpUrl(value);
  if (Result.isSuccess(parsed)) {
    return parsed.success;
  }
  ctx.issues.push({ code: "custom", message: parsed.failure._tag, input: value });
  return z.NEVER;
});

/** One search request, as every provider receives it. */
export type SearchInput = { readonly query: SearchQuery; readonly maxResults: number };

/** Outbound port for one search provider. */
export type SearchProvider = {
  readonly name: SearchProviderName;
  readonly transport: "mcp" | "api";
  /** Search once; interrupting the effect aborts the request. */
  readonly search: (
    input: SearchInput,
  ) => Effect.Effect<readonly NormalizedSearchResult[], ProviderError>;
};

/**
 * Outbound port for provider-side page fetching (the fetch rescue path).
 *
 * The only caller falls through to the next provider on any failure, so the
 * port reports content or nothing rather than a failure union.
 */
export type FetchProvider = {
  readonly name: "exa" | "parallel";
  /** Read one URL as markdown; undefined when the provider produced no usable content, for any reason. */
  readonly fetchMarkdown: (url: PublicHttpUrl) => Effect.Effect<string | undefined>;
};
