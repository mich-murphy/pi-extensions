import { readFileSync } from "node:fs";
import { Schema } from "effect";

const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.String,
      bin: Schema.Struct({ pi: Schema.String }),
    }),
  ),
);

export function readManifest(path: string) {
  return decodeManifest(readFileSync(path, "utf8"));
}
