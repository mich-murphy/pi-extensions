import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Hegel } from "@hegeldev/hegel";
import {
  arrays,
  integers,
  oneOf,
  record,
  sampledFrom,
  text as textGen,
} from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { propertySettings } from "../../../test-support/hegel-settings";
import { contextRow, selectContext } from "../context";

const ZONE_START = "\u001B]133;A\u0007";
const ZONE_END = "\u001B]133;B\u0007";
const settings = propertySettings(200);

type Block = { kind: "filler" | "prompt"; first: string; body: Array<string>; pad: number };

type Placed = { start: number; lastText: number; text: string };

function layout(blocks: ReadonlyArray<Block>) {
  const lines: Array<string> = [];
  const placed: Array<Placed> = [];

  for (const block of blocks) {
    if (block.kind === "filler") {
      lines.push(block.first, ...block.body);
      continue;
    }

    const start = lines.length;
    lines.push(`${ZONE_START}  ${block.first}  `, ...block.body);
    const words = [block.first, ...block.body].map((line) => line.trim());
    const lastBody = block.body.findLastIndex((line) => line.trim() !== "");
    lines.push(...Array.from({ length: block.pad }, () => "   "), ZONE_END);
    placed.push({
      start,
      lastText: lastTextRow(block, start, lastBody),
      text: words.filter((word) => word !== "").join(" "),
    });
  }

  return { lines, placed };
}

function lastTextRow(block: Block, start: number, lastBody: number): number {
  if (lastBody >= 0) {
    return start + lastBody + 1;
  }

  return block.first.trim() === "" ? -1 : start;
}

function expectedContext(placed: ReadonlyArray<Placed>, scrollTop: number): string | undefined {
  const prompt = placed.findLast((span) => span.start <= scrollTop);

  return prompt === undefined || prompt.lastText >= scrollTop || prompt.text === ""
    ? undefined
    : prompt.text;
}

function assertSelect(blocks: ReadonlyArray<Block>, raw: number): void {
  const { lines, placed } = layout(blocks);
  const scrollTop = raw % (lines.length + 1);
  const got = selectContext(lines, scrollTop);
  assert.equal(got, expectedContext(placed, scrollTop));
  assert.ok(got === undefined || got.trim() !== "", "never blank");
}

function assertRow(text: string, width: number): void {
  const row = contextRow(text, width);
  assert.equal(visibleWidth(row), width, JSON.stringify(row));
  assert.ok(!row.includes("\u001B"), "no ESC");

  for (const character of row) {
    const code = character.codePointAt(0) ?? 0;
    assert.ok(code >= 32 && !(code >= 127 && code <= 159), `control U+${code.toString(16)}`);
  }
}

const word = textGen({ minSize: 1, maxSize: 6, codec: "ascii" }).filter((s) =>
  /^[a-z]+$/iu.test(s),
);

const spaces = sampledFrom(["", "   ", " "]);

const block = record({
  kind: sampledFrom(["filler", "prompt"] as const),
  first: oneOf(word, word, spaces),
  body: arrays(oneOf(word, spaces), { maxSize: 4 }),
  pad: integers({ minValue: 0, maxValue: 3 }),
});

const fragments = [
  "é",
  "👨‍👩‍👧",
  "日本語",
  "😀",
  "\u001B[31mred\u001B[0m",
  "\u001B]8;;http://x\u0007link\u001B]8;;\u0007",
  "\u001B]0;title\u001B\\",
  "\u0001\u0008\t\n\r",
  "\u0080\u009B\u009F\u007F",
  "ab",
  " ",
];

describe("scroll context properties", () => {
  test("selectContext returns the last prompt starting at or above scrollTop", () => {
    new Hegel((tc) => {
      const blocks = tc.draw(arrays(block, { maxSize: 8 }));
      const raw = tc.draw(integers({ minValue: 0, maxValue: 200 }));
      assertSelect(blocks, raw);
    })
      .settings(settings)
      .runSync();
  });

  test("contextRow is exactly width cells with no escapes or controls", () => {
    new Hegel((tc) => {
      const text = tc
        .draw(arrays(oneOf(sampledFrom(fragments), textGen({ maxSize: 4 })), { maxSize: 12 }))
        .join("");

      const width = tc.draw(integers({ minValue: 3, maxValue: 40 }));
      assertRow(text, width);
    })
      .settings(settings)
      .runSync();
  });
});
