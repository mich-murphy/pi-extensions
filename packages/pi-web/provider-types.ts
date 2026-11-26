import { Option, Result, Schema, SchemaGetter } from "effect";
import type { Effect } from "effect";
import type { CredentialFailure } from "./credentials";
import { describeNetworkFailure } from "./network";
import { isPublicHttpUrl, parsePublicHttpUrl } from "./types";
import type {
  NormalizedSearchResult,
  PublicHttpUrl,
  SearchProviderName,
  SearchQuery,
} from "./types";

export class ProviderRequestFailed extends Schema.TaggedError<ProviderRequestFailed>()(
  "ProviderRequestFailed",
  {
    hostname: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return lowerInitial(describeNetworkFailure(this.cause, this.hostname));
  }
}

export class ProviderTimedOut extends Schema.TaggedError<ProviderTimedOut>()("ProviderTimedOut", {
  timeoutSeconds: Schema.Number,
}) {
  override get message(): string {
    return `timed out after ${this.timeoutSeconds}s`;
  }
}

export class ProviderStatusRejected extends Schema.TaggedError<ProviderStatusRejected>()(
  "ProviderStatusRejected",
  {
    status: Schema.Number,
  },
) {
  override get message(): string {
    return `rejected (HTTP ${this.status})`;
  }
}

export class ProviderResponseTooLarge extends Schema.TaggedError<ProviderResponseTooLarge>()(
  "ProviderResponseTooLarge",
  {},
) {
  override get message(): string {
    return "response too large";
  }
}

export class ProviderProtocolInvalid extends Schema.TaggedError<ProviderProtocolInvalid>()(
  "ProviderProtocolInvalid",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return "returned an invalid response";
  }
}

export class ProviderToolError extends Schema.TaggedError<ProviderToolError>()(
  "ProviderToolError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail === "" ? "reported an error" : `reported an error: ${this.detail}`;
  }
}

export type ProviderError =
  | CredentialFailure
  | ProviderRequestFailed
  | ProviderTimedOut
  | ProviderStatusRejected
  | ProviderResponseTooLarge
  | ProviderProtocolInvalid
  | ProviderToolError;

function lowerInitial(text: string): string {
  const second = text.charAt(1);

  return second !== "" && second === second.toUpperCase() && second !== second.toLowerCase()
    ? text
    : text.charAt(0).toLowerCase() + text.slice(1);
}

export type ProviderJson = typeof Schema.Json.Type;

export const ProviderJson: Schema.Codec<ProviderJson> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Number,
    Schema.String,
    Schema.Array(ProviderJson),
    Schema.Record(Schema.String, ProviderJson),
  ]),
);

const decodeJsonBody = Schema.decodeUnknownResult(Schema.fromJsonString(ProviderJson));

export function parseJsonBody(
  bodyText: string,
): Result.Result<ProviderJson, ProviderProtocolInvalid> {
  return Result.mapError(
    decodeJsonBody(bodyText),
    () => new ProviderProtocolInvalid({ reason: "Invalid JSON response" }),
  );
}

export function lenientArray<S extends Schema.Constraint & Schema.ConstraintDecoder<unknown>>(
  item: S,
) {
  const decodeItem = Schema.decodeUnknownOption(item);

  return Schema.Array(Schema.Unknown).pipe(
    Schema.decodeTo(Schema.Array(Schema.toType(item)), {
      decode: SchemaGetter.transform((items: ReadonlyArray<unknown>) =>
        items.flatMap((entry) => Option.toArray(decodeItem(entry))),
      ),
      encode: SchemaGetter.passthrough({ strict: false }),
    }),
  );
}

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

export const optionalTextSchema = orFallback(TrimmedOptionalText, undefined);

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

export type SearchInput = { readonly query: SearchQuery; readonly maxResults: number };

export type SearchProvider = {
  readonly name: SearchProviderName;
  readonly transport: "mcp" | "api";
  readonly freeTier?: true;
  readonly search: (
    input: SearchInput,
  ) => Effect.Effect<ReadonlyArray<NormalizedSearchResult>, ProviderError>;
};

export type FetchProvider = {
  readonly name: "exa" | "parallel";
  readonly fetchMarkdown: (url: PublicHttpUrl) => Effect.Effect<string | undefined>;
};
