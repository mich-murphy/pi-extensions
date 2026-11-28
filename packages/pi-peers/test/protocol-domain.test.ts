import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { Message } from "../protocol/schema.js";

const message = { id: "3".repeat(32), kind: "request", format: "text", content: "hello" };
const decodeMessage = Schema.decodeUnknownSync(Message, { onExcessProperty: "error" });

describe("protocol domain schema API", () => {
  test("Message is usable independently for local authored tools", () => {
    expect(decodeMessage(message)).toStrictEqual(message);
    expect(() => decodeMessage({ ...message, extra: true })).toThrow(Schema.SchemaError);
  });

  describe("authored content cap of 24,576 UTF-8 bytes", () => {
    test("the per-field cap counts bytes, not characters", () => {
      expect(decodeMessage({ ...message, content: "€".repeat(8192) }).content).toHaveLength(8192);
      expect(() => decodeMessage({ ...message, content: `${"€".repeat(8192)}x` })).toThrow(
        Schema.SchemaError,
      );
    });
  });
});
