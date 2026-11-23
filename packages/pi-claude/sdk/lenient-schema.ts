import { Effect, Schema } from "effect";

export function withFallback<S extends Schema.Top>(
  schema: S,
  fallback: S["Type"],
): Schema.middlewareDecoding<S, S["DecodingServices"]> {
  return Schema.catchDecoding<S>(() => Effect.succeedSome(fallback))(schema);
}

export function lenientOptional<S extends Schema.Top>(schema: S) {
  return Schema.optional(withFallback(Schema.UndefinedOr(schema), undefined));
}
