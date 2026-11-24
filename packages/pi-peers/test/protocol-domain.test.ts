import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { MAX_AUTHORED_BYTES, Message } from "../protocol/schema.js";

const message = { id: "3".repeat(32), kind: "request", format: "text", content: "hello" };
const decodeMessage = Schema.decodeUnknownSync(Message, { onExcessProperty: "error" });

describe("protocol domain schema API", () => {
  test("Message is usable independently for local authored tools", () => {
    expect(decodeMessage(message)).toStrictEqual(message);
    expect(() => decodeMessage({ ...message, extra: true })).toThrow(Schema.SchemaError);
  });

  describe("authored content cap of 24,576 UTF-8 bytes", () => {
    test("a Message decoded on its own accepts content exactly at the cap and rejects one byte more", () => {
      expect(
        decodeMessage({ ...message, content: "x".repeat(MAX_AUTHORED_BYTES) }).content,
      ).toHaveLength(MAX_AUTHORED_BYTES);
      expect(() =>
        decodeMessage({ ...message, content: "x".repeat(MAX_AUTHORED_BYTES + 1) }),
      ).toThrow(Schema.SchemaError);
    });

    test("the per-field cap counts bytes, not characters", () => {
      expect(decodeMessage({ ...message, content: "€".repeat(8192) }).content).toHaveLength(8192);
      expect(() => decodeMessage({ ...message, content: `${"€".repeat(8192)}x` })).toThrow(
        Schema.SchemaError,
      );
    });
  });
});
