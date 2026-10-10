import { Option, Result, Schema, SchemaGetter } from "effect";
import type { Effect } from "effect";
import { describeNetworkFailure } from "./network";
import { isPublicHttpUrl, parsePublicHttpUrl } from "./types";
import type {
  NormalizedSearchResult,
  PublicHttpUrl,
  SearchProviderName,
  SearchQuery,
} from "./types";

/** A provider request failed at the network level (DNS, connection, TLS, or body stream). */
export class ProviderRequestFailed extends Schema.TaggedError<ProviderRequestFailed>()(
  "ProviderRequestFailed",
  {
    /** The provider host; messages name only this, never the URL. */
    hostname: Schema.String,
    /** The underlying fetch or stream error, kept for local diagnosis only. */
    cause: Schema.optional(Schema.Defect()),
  },
) {
  /** Safe lower-case phrase for a "<provider>: <reason>" line, e.g. "could not resolve host x". */
  override get message(): string {
    return lowerInitial(describeNetworkFailure(this.cause, this.hostname));
  }
}

/** A provider call ran past its deadline. */
export class ProviderTimedOut extends Schema.TaggedError<ProviderTimedOut>()("ProviderTimedOut", {
  /** The deadline in whole seconds. */
  timeoutSeconds: Schema.Number,
}) {
  /** Safe lower-case phrase naming the deadline. */
  override get message(): string {
    return `timed out after ${this.timeoutSeconds}s`;
  }
}

/** A provider answered with a non-2xx status. */
export class ProviderStatusRejected extends Schema.TaggedError<ProviderStatusRejected>()(
  "ProviderStatusRejected",
  {
    /** The HTTP status code. */
    status: Schema.Number,
  },
) {
  /** Safe lower-case phrase naming the status. */
  override get message(): string {
    return `rejected (HTTP ${this.status})`;
  }
}

/** A provider response exceeded the byte cap. */
export class ProviderResponseTooLarge extends Schema.TaggedError<ProviderResponseTooLarge>()(
  "ProviderResponseTooLarge",
  {},
) {
  /** Safe lower-case phrase. */
  override get message(): string {
    return "response too large";
  }
}

/** A provider response did not match the expected protocol or payload shape. */
export class ProviderProtocolInvalid extends Schema.TaggedError<ProviderProtocolInvalid>()(
  "ProviderProtocolInvalid",
  {
    /** What was wrong with the response, for local diagnosis. */
    reason: Schema.String,
  },
) {
  /** Safe lower-case phrase; the reason stays out of user-facing text. */
  override get message(): string {
    return "returned an invalid response";
  }
}

/** The provider's tool reported an error (JSON-RPC error or an isError tool result). */
export class ProviderToolError extends Schema.TaggedError<ProviderToolError>()(
  "ProviderToolError",
  {
    /** The provider's own error text: whitespace-collapsed, at most 200 chars, secrets redacted. */
    detail: Schema.String,
  },
) {
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
 * Array schema that drops items failing `item`, so one malformed provider record never sinks
 * the response. A non-array input still fails; wrap with {@link orFallback} to recover from it.
 *
 * @template S - Item schema; it must decode without services.
 * @param item - Schema each array element must decode with.
 * @returns A schema decoding an array into its decodable items, in order.
 */
export function lenientArray<S extends Schema.Constraint & Schema.ConstraintDecoder<unknown>>(
  item: S,
) {
  const decodeItem = Schema.decodeUnknownOption(item);
  return Schema.Array(Schema.Unknown).pipe(
    Schema.decodeTo(Schema.Array(Schema.toType(item)), {
      decode: SchemaGetter.transform((items: readonly unknown[]) =>
        items.flatMap((entry) => Option.toArray(decodeItem(entry))),
      ),
      encode: SchemaGetter.passthrough({ strict: false }),
    }),
  );
}

/**
 * Struct field schema that decodes with `schema`, or yields `fallback` when the key is missing or
 * its value fails to decode, so one malformed provider field never sinks its record.
 *
 * @template S - Field schema; it must decode without services.
 * @param schema - Schema the field value should decode with.
 * @param fallback - Value used when the key is missing or the value is invalid.
 * @returns A struct field schema that always decodes.
 */
export function orFallback<S extends Schema.Constraint & Schema.ConstraintDecoder<unknown>>(
  schema: S,
  fallback: S["Type"],
) {
  const decode = Schema.decodeUnknownOption(schema);
  return Schema.optionalKey(Schema.Unknown).pipe(
    Schema.decodeTo(Schema.toType(schema), {
      decode: SchemaGetter.transformOptional((input: Option.Option<unknown>) =>
        Option.some(
          Option.getOrElse(
            Option.flatMap(input, (value) => decode(value)),
            () => fallback,
          ),
        ),
      ),
      encode: SchemaGetter.passthrough({ strict: false }),
    }),
  );
}

const TrimmedOptionalText = Schema.String.pipe(
  Schema.decodeTo(Schema.UndefinedOr(Schema.String), {
    decode: SchemaGetter.transform((value: string) => value.trim() || undefined),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
);

/** Untrusted provider text, trimmed; blank, missing, or non-string values read as undefined. */
export const optionalTextSchema = orFallback(TrimmedOptionalText, undefined);

/**
 * Untrusted provider URL, accepted only when it parses as a public HTTP(S) URL.
 * parsePublicHttpUrl normalizes; any input it rejects is left as is and fails the refinement,
 * because every string isPublicHttpUrl accepts also parses.
 */
export const publicHttpUrlSchema = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.pipe(Schema.refine(isPublicHttpUrl, { expected: "a public HTTP(S) URL" })),
    {
      decode: SchemaGetter.transform((value: string) => {
        const parsed = parsePublicHttpUrl(value);
        return Result.isSuccess(parsed) ? parsed.success : value;
      }),
      encode: SchemaGetter.passthrough(),
    },
  ),
);

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
