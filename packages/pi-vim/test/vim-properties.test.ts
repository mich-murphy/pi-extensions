import assert from "node:assert/strict";
import type { CustomEditor } from "@earendil-works/pi-coding-agent";
import { setKittyProtocolActive } from "@earendil-works/pi-tui";
import {
  arrays,
  integers,
  just,
  oneOf,
  sampledFrom,
  text as textGen,
} from "@hegeldev/hegel/generators";
import { afterEach, describe, test } from "vitest";
import {
  assertHegel,
  propertySettings,
  propertyTimeout,
} from "../../../test-support/hegel-settings";
import { createEditor, KEYBOARDS, resetKeyboard } from "./vim-harness";
import type { Keyboard } from "./vim-harness";

const ALPHABET = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
  " ",
  ".",
  "\n",
  "😀",
  "é",
];

const TOKENS = [
  "h",
  "j",
  "k",
  "l",
  "0",
  "$",
  "w",
  "b",
  "x",
  "D",
  "i",
  "a",
  "A",
  "I",
  "o",
  "O",
  "u",
  "C",
  "q",
  " ",
  "Z",
  "dd",
  "dw",
  "diw",
  "cw",
  "ciw",
  "cc",
  "ESC",
  "\u0001",
  "\u001B[C",
  "\u001B[B",
  "\u0005",
];

const MOTIONS = new Set(["h", "j", "k", "l", "0", "$", "w", "b"]);
const EDITS = new Set(["x", "D", "dd", "dw", "diw"]);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

type Snapshot = {
  readonly text: string;
  readonly lines: ReadonlyArray<string>;
  readonly line: number;
  readonly col: number;
  readonly label: string;
};

function snapshot(editor: CustomEditor): Snapshot {
  const { line, col } = editor.getCursor();

  const label = /(?<label> (?:INSERT|NORMAL[^ ]*(?: [a-z]+)?) )$/u.exec(
    editor.render(60).at(-1) ?? "",
  );

  return {
    text: editor.getText(),
    lines: editor.getLines(),
    line,
    col,
    label: label?.groups?.label ?? "",
  };
}

function send(editor: CustomEditor, keyboard: Keyboard, token: string): void {
  if (token === "ESC") {
    editor.handleInput(keyboard.escape);

    return;
  }

  const keys = token.length > 1 && !token.startsWith("\u001B") ? token.split("") : [token];

  for (const key of keys) {
    editor.handleInput(keyboard.press(key));
  }
}

function checkBounds(after: Snapshot): void {
  assert.ok(!LONE_SURROGATE.test(after.text), "lone surrogate");

  if (after.label.includes("NORMAL")) {
    assert.ok(after.line < after.lines.length, "line in range");
    const length = after.lines[after.line]?.length ?? 0;
    assert.ok(after.col <= Math.max(0, length - 1), `col ${after.col} within ${length}`);
  }
}

function withoutCodePointAt(line: string, col: number): string {
  const points = line.match(/./gsu) ?? [];
  let offset = 0;

  for (const [index, point] of points.entries()) {
    if (offset === col) {
      return points.toSpliced(index, 1).join("");
    }

    offset += point.length;
  }

  return line;
}

function checkOracles(token: string, before: Snapshot, after: Snapshot): void {
  if (before.label !== " NORMAL ") {
    return;
  }

  if (MOTIONS.has(token)) {
    assert.equal(after.text, before.text, `motion ${token} changed text`);
  }

  if (token === "x") {
    const expected = before.lines.with(
      before.line,
      withoutCodePointAt(before.lines[before.line] ?? "", before.col),
    );

    assert.deepEqual(after.lines, expected);
  }

  if (token === "diw" || token === "ciw") {
    checkInnerWordOnBlank(token, before, after);
  }

  if (token === "dd") {
    const expected = before.lines.length === 1 ? [""] : before.lines.toSpliced(before.line, 1);
    assert.deepEqual(after.lines, expected);
  }
}

const isBlankAt = (line: string, col: number): boolean => !/\S/u.test(line.slice(col, col + 1));

function checkInnerWordOnBlank(token: string, before: Snapshot, after: Snapshot): void {
  if (!isBlankAt(before.lines[before.line] ?? "", before.col)) {
    return;
  }

  assert.equal(after.text, before.text, `${token} changed text on whitespace`);
  assert.deepEqual([after.line, after.col], [before.line, before.col], `${token} moved cursor`);
}

type PendingUndo = { readonly restored: string; readonly remaining: number };

function undosNeeded(token: string, before: Snapshot): number {
  return token === "dd" && before.lines.length > 1 ? 2 : 1;
}

function trackUndo(
  pending: PendingUndo | undefined,
  token: string,
  before: Snapshot,
  after: Snapshot,
): PendingUndo | undefined {
  if (token === "u") {
    if (pending === undefined) {
      return undefined;
    }

    if (pending.remaining > 1) {
      return { ...pending, remaining: pending.remaining - 1 };
    }

    assert.equal(after.text, pending.restored, "u did not restore the pre-edit text");

    return undefined;
  }

  const changed = before.label === " NORMAL " && EDITS.has(token) && before.text !== after.text;

  return changed ? { restored: before.text, remaining: undosNeeded(token, before) } : undefined;
}

function assertDeleteWord(keyboard: Keyboard, line: string, col: number): void {
  setKittyProtocolActive(keyboard.kittyProtocol);
  const editor = createEditor();
  editor.setText(line);
  editor.handleInput(keyboard.escape);

  for (const token of ["0", ...Array.from({ length: col }, () => "l")]) {
    send(editor, keyboard, token);
  }

  assert.equal(editor.getCursor().col, col, "cursor placed");
  let end = col;

  while (line.charAt(end) === " ") {
    end += 1;
  }

  while (end < line.length && line.charAt(end) !== " ") {
    end += 1;
  }

  send(editor, keyboard, "dw");
  assert.equal(editor.getText(), line.slice(0, col) + line.slice(end), "dw deletes one word");
}

function runTrace(
  keyboard: Keyboard,
  lines: ReadonlyArray<ReadonlyArray<string>>,
  tokens: ReadonlyArray<string>,
): void {
  setKittyProtocolActive(keyboard.kittyProtocol);
  const editor = createEditor();
  editor.setText(lines.map((line) => line.join("")).join("\n"));
  editor.handleInput(keyboard.escape);
  let pending: PendingUndo | undefined;

  for (const token of tokens) {
    const before = snapshot(editor);
    send(editor, keyboard, token);
    const after = snapshot(editor);
    checkBounds(after);
    checkOracles(token, before, after);
    pending = trackUndo(pending, token, before, after);
  }
}

describe.each(KEYBOARDS)("vimEditor properties with a $name keyboard", (keyboard) => {
  afterEach(resetKeyboard);

  test("random key traces keep the editor invariants", { timeout: propertyTimeout(30_000) }, () => {
    assertHegel(propertySettings(), (tc) => {
      const lines = tc.draw(
        arrays(arrays(sampledFrom(ALPHABET), { maxSize: 12 }), {
          minSize: 1,
          maxSize: 5,
        }),
        "lines",
      );

      const anyLine = integers({ minValue: 0, maxValue: lines.length - 1 });
      const up = tc.draw(oneOf(just(0), anyLine, anyLine), "up");
      const tokens = tc.draw(arrays(sampledFrom(TOKENS), { maxSize: 20 }), "tokens");
      runTrace(keyboard, lines, [...Array.from({ length: up }, () => "k"), ...tokens]);
    });
  });

  test("dw deletes up to the next word start", { timeout: propertyTimeout(30_000) }, () => {
    assertHegel(propertySettings(), (tc) => {
      const line = tc.draw(textGen({ alphabet: "ab ", minSize: 1, maxSize: 12 }), "line");
      const col = tc.draw(integers({ minValue: 0, maxValue: line.length - 1 }), "col");
      assertDeleteWord(keyboard, line, col);
    });
  });
});
