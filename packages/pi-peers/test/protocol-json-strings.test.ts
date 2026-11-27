import { describe, expect, test } from "vitest";
import { decodeJson, ProtocolError } from "../protocol/json.js";

function bytes(text: string): Uint8Array {
  return Buffer.from(text, "utf8");
}

describe("JSON string scanning", () => {
  test.each([
    [String.raw`{"a":"x\"y"}`, { a: 'x"y' }],
    [String.raw`{"a":"x\\"}`, { a: "x\\" }],
    [String.raw`{"a":"x\\\"y"}`, { a: String.raw`x\"y` }],
    [String.raw`{"a":"\\\\","b":"q"}`, { a: String.raw`\\`, b: "q" }],
    ['{"a":""}', { a: "" }],
    [String.raw`{"\"k":1}`, { '"k': 1 }],
  ])("accepts escaped quotes and backslashes in %s", (text, expected) => {
    expect(decodeJson(bytes(text))).toStrictEqual(expected);
  });

  test.each([
    String.raw`{"a":"x\"}`,
    '{"a":"x\\',
    '{"a":"unterminated',
    String.raw`{"a":"x\\\"}`,
    '{"a":"x","a":"y"}',
    String.raw`{"a":"x\"","a\"":1`,
  ])("rejects unterminated or duplicate strings in %s", (text) => {
    expect(() => decodeJson(bytes(text))).toThrow(ProtocolError);
  });
});
