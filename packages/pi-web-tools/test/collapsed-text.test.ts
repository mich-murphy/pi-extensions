import { describe, expect, test } from "vitest";
import { CollapsedTextLength, normalizedTextLength } from "../collapsed-text";

// Every code unit JavaScript's \s matches, plus non-whitespace neighbours.
const ALPHABET = [
  "a",
  "b",
  "é",
  "​",
  " ",
  "\t",
  "\n",
  "\v",
  "\f",
  "\r",
  " ",
  " ",
  " ",
  " ",
  " ",
  "\u2028",
  "\u2029",
  " ",
  " ",
  "　",
  "﻿",
];

// Park and Miller's minimal standard generator: every product stays an exact integer.
function createRandom(seed: number): (limit: number) => number {
  let state = seed;
  return (limit) => {
    state = (state * 48_271) % 2_147_483_647;
    return state % limit;
  };
}

function randomText(random: (limit: number) => number): string {
  let text = "";
  const length = random(12);
  for (let index = 0; index < length; index += 1) {
    text += ALPHABET[random(ALPHABET.length)];
  }
  return text;
}

const expectedLength = (text: string) => text.replaceAll(/\s+/gu, " ").trim().length;

describe("normalizedTextLength", () => {
  test.each(["", " ", "  \n\t ", "a", " a ", "a  b", " a　　b﻿"])(
    "measures %j as the collapsed, trimmed text",
    (text) => {
      expect(normalizedTextLength(text)).toBe(expectedLength(text));
    },
  );

  test("matches the regex normalization on random text", () => {
    const random = createRandom(7);
    for (let run = 0; run < 2000; run += 1) {
      const text = randomText(random);
      expect(normalizedTextLength(text)).toBe(expectedLength(text));
    }
  });
});

describe("collapsedTextLength", () => {
  test("appending measures of pieces measures their concatenation", () => {
    const random = createRandom(11);
    for (let run = 0; run < 2000; run += 1) {
      const pieces = Array.from({ length: 1 + random(4) }, () => randomText(random));
      const combined = new CollapsedTextLength();
      for (const piece of pieces) {
        const measure = new CollapsedTextLength();
        measure.appendText(piece);
        combined.append(measure);
      }
      expect(combined.trimmedLength()).toBe(expectedLength(pieces.join("")));
    }
  });
});
