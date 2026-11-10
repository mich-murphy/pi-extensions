import { Hegel } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { propertySettings } from "../../../test-support/hegel-settings";
import { CollapsedTextLength, normalizedTextLength } from "../collapsed-text";

const ALPHABET = [
  "a",
  "b",
  "é",
  "😀",
  "\uD800",
  "\uDC00",
  "\u200B",
  " ",
  "\t",
  "\n",
  "\v",
  "\f",
  "\r",
  "\u00A0",
  "\u1680",
  "\u2000",
  "\u200A",
  "\u202F",
  "\u2028",
  "\u2029",
  "\u205F",
  "\u3000",
  "\uFEFF",
];
const textGenerator = gs
  .arrays(gs.sampledFrom(ALPHABET), { maxSize: 14 })
  .map((parts) => parts.join(""));
const settings = propertySettings(200);

const expectedLength = (text: string) => text.replaceAll(/\s+/gu, " ").trim().length;

describe("normalizedTextLength", () => {
  test("matches the regex normalization on generated text", () => {
    new Hegel((tc) => {
      const text = tc.draw(textGenerator, "text");
      expect(normalizedTextLength(text)).toBe(expectedLength(text));
    })
      .settings(settings)
      .runSync();
  });
});

describe("collapsedTextLength", () => {
  test("counts UTF-16 units even when a surrogate pair spans appended pieces", () => {
    const measure = new CollapsedTextLength();
    measure.appendText(" \uD83D");
    const following = new CollapsedTextLength();
    following.appendText("\uDE00 \uD800 \uDC00 ");
    measure.append(following);

    expect(measure.trimmedLength()).toBe(6);
    expect(normalizedTextLength(" 😀 \uD800 \uDC00 ")).toBe(6);
  });

  test("appending measures of pieces measures their concatenation", () => {
    new Hegel((tc) => {
      const pieces = tc.draw(gs.arrays(textGenerator, { minSize: 1, maxSize: 4 }), "pieces");
      const combined = new CollapsedTextLength();
      for (const piece of pieces) {
        const measure = new CollapsedTextLength();
        measure.appendText(piece);
        combined.append(measure);
      }
      expect(combined.trimmedLength()).toBe(expectedLength(pieces.join("")));
      // Appending text piecewise gives the same measure.
      const textual = new CollapsedTextLength();
      for (const piece of pieces) {
        textual.appendText(piece);
      }
      expect(textual.trimmedLength()).toBe(combined.trimmedLength());
    })
      .settings(settings)
      .runSync();
  });
});
