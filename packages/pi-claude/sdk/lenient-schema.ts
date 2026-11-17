import { Effect, Schema } from "effect";

/**
 * Recover from any decoding failure of a present value with a fixed fallback.
 *
 * This is the Schema form of zod's `.catch(value)`. Unlike zod, it does not cover a missing
 * struct key; wrap the result in `Schema.optional` and default at the use site for that.
 *
 * @template S - Schema whose failures are replaced.
 * @param schema - Schema to decode with.
 * @param fallback - Value decoded in place of any malformed input.
 * @returns A schema that never fails to decode.
 */
export function withFallback<S extends Schema.Top>(
  schema: S,
  fallback: S["Type"],
): Schema.middlewareDecoding<S, S["DecodingServices"]> {
  return Schema.catchDecoding<S>(() => Effect.succeedSome(fallback))(schema);
}

/**
 * An optional struct field whose malformed value decodes as `undefined` instead of failing.
 *
 * @template S - Schema of a well-formed value.
 * @param schema - Schema to decode a present value with.
 * @returns A struct field that is absent, `undefined`, or a well-formed value.
 */
export function lenientOptional<S extends Schema.Top>(schema: S) {
  return Schema.optional(withFallback(Schema.UndefinedOr(schema), undefined));
}
