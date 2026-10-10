import { z } from "zod";
import { isOperationTimeoutError } from "./network";
import { err, ok } from "./result";
import type { Result } from "./result";
import { parsePublicHttpUrl } from "./types";
import type {
  NormalizedSearchResult,
  PublicHttpUrl,
  SearchProviderName,
  SearchQuery,
} from "./types";

/** Expected failures of a provider call over either transport (hosted MCP or REST API). */
export type ProviderError =
  | { readonly _tag: "ProviderRequestFailed" }
  | { readonly _tag: "ProviderTimedOut"; readonly timeoutSeconds: number }
  | { readonly _tag: "ProviderCancelled" }
  | { readonly _tag: "ProviderStatusRejected"; readonly status: number }
  | { readonly _tag: "ProviderResponseTooLarge" }
  | { readonly _tag: "ProviderProtocolInvalid"; readonly reason: string }
  | { readonly _tag: "ProviderToolError" };

/** Parse an untrusted provider response body as JSON. */
export function parseJsonBody(
  bodyText: string,
): Result<unknown, Extract<ProviderError, { readonly _tag: "ProviderProtocolInvalid" }>> {
  try {
    return ok(JSON.parse(bodyText));
  } catch {
    return err({ _tag: "ProviderProtocolInvalid", reason: "Invalid JSON response" });
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
  if (parsed._tag === "ok") {
    return parsed.value;
  }
  ctx.issues.push({ code: "custom", message: parsed.error._tag, input: value });
  return z.NEVER;
});

/** Classify an aborted provider request as an operation-deadline timeout or a caller cancellation. */
export function classifyProviderAbort(signal: AbortSignal): ProviderError {
  if (isOperationTimeoutError(signal.reason)) {
    return { _tag: "ProviderTimedOut", timeoutSeconds: signal.reason.timeoutSeconds };
  }
  return { _tag: "ProviderCancelled" };
}

/** One search request, as every provider receives it. */
export type SearchInput = { readonly query: SearchQuery; readonly maxResults: number };

/** Per-call options for a provider request. */
export type ProviderCallOptions = { readonly signal?: AbortSignal | undefined };

/** Outbound port for one search provider. */
export type SearchProvider = {
  readonly name: SearchProviderName;
  readonly transport: "mcp" | "api";
  readonly search: (
    input: SearchInput,
    options?: ProviderCallOptions,
  ) => Promise<Result<readonly NormalizedSearchResult[], ProviderError>>;
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
  readonly fetchMarkdown: (
    url: PublicHttpUrl,
    options?: { readonly signal?: AbortSignal | undefined },
  ) => Promise<string | undefined>;
};
