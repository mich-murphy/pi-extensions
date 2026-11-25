import { Schema, SchemaGetter } from "effect";

export const USAGE_LIMIT_CHANNEL = "usage-limit";

const providerName = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.UndefinedOr(Schema.String), {
    decode: SchemaGetter.transform((value) =>
      Schema.is(Schema.String)(value) ? value : undefined,
    ),
    encode: SchemaGetter.transform((value) => value),
  }),
);

const usageLimitNotice = Schema.Struct({
  provider: Schema.optional(providerName),
  resetsAt: Schema.Finite.check(
    Schema.makeFilter((epoch) => Number.isFinite(new Date(epoch).getTime())),
  ),
});

export type UsageLimitNotice = typeof usageLimitNotice.Type;

export const decodeUsageLimitNotice = Schema.decodeUnknownResult(usageLimitNotice);
