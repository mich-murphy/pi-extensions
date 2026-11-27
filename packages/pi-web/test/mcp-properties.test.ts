import assert from "node:assert/strict";
import { Hegel } from "@hegeldev/hegel";
import { arrays, oneOf, sampledFrom, text as textGen } from "@hegeldev/hegel/generators";
import { Result } from "effect";
import { describe, test } from "vitest";
import { propertySettings } from "../../../test-support/hegel-settings";
import { parseMcpMessage } from "../mcp";

const settings = propertySettings(200);

const FRAGMENTS = [
  "data:",
  "data: ",
  "\u2028",
  "\u2029",
  "\u0085",
  "\r",
  "\n",
  "\r\n",
  " ",
  "{",
  "[",
];

const piece = oneOf(sampledFrom(FRAGMENTS), textGen({ maxSize: 8 }));

const value = arrays(piece, { maxSize: 12 }).map((pieces) => pieces.join(""));

const INDENTS: ReadonlyArray<string | number> = [0, 2, "\t"];

const EOLS = ["\n", "\r\n"];

const PREAMBLES = ["", "event: message", ": keep-alive", "id: 7"];

describe("MCP message properties", () => {
  test("a plain JSON response parses to itself whatever its strings contain", () => {
    new Hegel((tc) => {
      const text = tc.draw(value, "text");
      const key = tc.draw(value, "key");
      const indent = tc.draw(sampledFrom(INDENTS), "indent");
      const message = { jsonrpc: "2.0", id: 2, result: { text, [key]: [text] } };
      const body = JSON.stringify(message, null, indent);

      assert.deepStrictEqual(
        parseMcpMessage(body, "application/json"),
        Result.succeed(JSON.parse(body)),
      );
    })
      .settings(settings)
      .runSync();
  });

  test("an SSE stream parses the same whatever content type labels it", () => {
    new Hegel((tc) => {
      const eol = tc.draw(sampledFrom(EOLS), "eol");
      const texts = tc.draw(arrays(value, { minSize: 1, maxSize: 4 }), "texts");
      const preamble = tc.draw(sampledFrom(PREAMBLES), "preamble");
      const body = texts
        .map((text) => {
          const data = `data: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { text } })}`;

          return [preamble, data].filter((line) => line !== "").join(eol) + eol + eol;
        })
        .join("");
      const streamed = parseMcpMessage(body, "text/event-stream");

      assert.ok(Result.isSuccess(streamed));
      assert.deepStrictEqual(parseMcpMessage(body, "application/json"), streamed);
    })
      .settings(settings)
      .runSync();
  });
});
