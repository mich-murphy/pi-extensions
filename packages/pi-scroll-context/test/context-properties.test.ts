import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Database, Hegel } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { contextRow, selectContext } from "../context";

const ZONE_START = "\u001B]133;A\u0007";
const ZONE_END = "\u001B]133;B\u0007";
const settings = { testCases: 200, seed: 12_345n, database: Database.disabled };

type Block = { kind: "filler" | "prompt"; first: string; body: string[]; pad: number };
type Placed = { start: number; lastText: number; text: string };

/** Lay blocks out line by line, recording where each prompt really starts (independent of the code). */
function layout(blocks: readonly Block[]): { lines: string[]; placed: Placed[] } {
  const lines: string[] = [];
  const placed: Placed[] = [];
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

function expectedContext(placed: readonly Placed[], scrollTop: number): string | undefined {
  const prompt = placed.findLast((span) => span.start <= scrollTop);
  return prompt === undefined || prompt.lastText >= scrollTop || prompt.text === ""
    ? undefined
    : prompt.text;
}

function assertSelect(blocks: readonly Block[], raw: number): void {
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

const word = gs
  .text({ minSize: 1, maxSize: 6, codec: "ascii" })
  .filter((s) => /^[a-z]+$/iu.test(s));
const spaces = gs.sampledFrom(["", "   ", " "]);
const block = gs.record({
  kind: gs.sampledFrom(["filler", "prompt"] as const),
  first: gs.oneOf(word, word, spaces),
  body: gs.arrays(gs.oneOf(word, spaces), { maxSize: 4 }),
  pad: gs.integers({ minValue: 0, maxValue: 3 }),
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
      const blocks = tc.draw(gs.arrays(block, { maxSize: 8 }));
      const raw = tc.draw(gs.integers({ minValue: 0, maxValue: 200 }));
      assertSelect(blocks, raw);
    })
      .databaseKey("pi-scroll-context/select")
      .settings(settings)
      .runSync();
  });

  test("contextRow is exactly width cells with no escapes or controls", () => {
    new Hegel((tc) => {
      const text = tc
        .draw(
          gs.arrays(gs.oneOf(gs.sampledFrom(fragments), gs.text({ maxSize: 4 })), { maxSize: 12 }),
        )
        .join("");
      const width = tc.draw(gs.integers({ minValue: 3, maxValue: 40 }));
      assertRow(text, width);
    })
      .databaseKey("pi-scroll-context/row")
      .settings(settings)
      .runSync();
  });
});
