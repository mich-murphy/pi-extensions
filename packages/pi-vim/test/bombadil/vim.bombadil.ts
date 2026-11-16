// Bombadil terminal specification for pi-vim: random keys against the real Pi CLI in a real
// terminal emulator. Run with `npm run test:bombadil`. The Hegel tests drive the editor in-process
// through a fake terminal; this drives the real stdin parser, renderer and resize path.
//
// Every property reads only what is on screen: the mode label on the editor's bottom border, the
// grid cells between the editor's borders, and the hardware cursor Pi places at the edit point.
import { always, next } from "@antithesishq/bombadil";
import type { Formula } from "@antithesishq/bombadil";
import { CharSet } from "@antithesishq/bombadil/actions";
import { actions, extract, weighted } from "@antithesishq/bombadil/terminal";
import type { State } from "@antithesishq/bombadil/terminal";
import { CharSets, typeFromSet } from "@antithesishq/bombadil/terminal/defaults/actions";
import { screenRows, typedText } from "../../../../test-support/bombadil-screen.ts";

export { noReplacementChars } from "@antithesishq/bombadil/terminal/defaults/properties";

type Mode = "INSERT" | "NORMAL";

/** The editor as drawn. `rows` holds each text row's grid cells, trailing blank cells removed. */
type Screen = {
  mode: Mode;
  pending: string;
  width: number;
  rows: string[][];
  /** The hardware cursor, with `row` counted from the first text row. */
  cursor: { row: number; col: number };
  /** A scroll indicator on a border: some text rows are not drawn. */
  clipped: boolean;
  /** The label ends the bottom border at the terminal's right edge. */
  labelAtEnd: boolean;
};

const LABEL = /^─.* (?<mode>INSERT|NORMAL)(?: (?<pending>\S+))?$/u;

/** The lowest row holding a border with a mode label, or -1. */
function labelRow(rows: readonly string[]): number {
  let index = rows.length - 1;
  while (index >= 0 && !LABEL.test(rows[index] ?? "")) {
    index--;
  }
  return index;
}

/** The editor's top border: the nearest border row above the bottom one, or -1. */
function topBorder(rows: readonly string[], bottom: number): number {
  let index = bottom - 1;
  while (index >= 0 && !(rows[index] ?? "").startsWith("─")) {
    index--;
  }
  return index;
}

/** A row's cell contents: "" marks the trailing half of a wide character. */
function rowCells(state: State, index: number): string[] {
  const cells = state.grid.row(index).map((cell) => cell.contents);
  while (cells.length > 0 && cells.at(-1) === " ") {
    cells.pop();
  }
  return cells;
}

/** The mode and pending command named by a bottom-border label. */
function labelParts(row: string): { mode: Mode; pending: string } {
  const groups = LABEL.exec(row)?.groups;
  return { mode: groups?.mode === "INSERT" ? "INSERT" : "NORMAL", pending: groups?.pending ?? "" };
}

/** The cells of every row between the borders. */
function textRows(state: State, top: number, bottom: number): string[][] {
  const text: string[][] = [];
  for (let index = top + 1; index < bottom; index++) {
    text.push(rowCells(state, index));
  }
  return text;
}

/** Pi marks text scrolled out of view in the borders. */
function isClipped(top: string, bottom: string): boolean {
  return !/^─+$/u.test(top) || bottom.includes(" more ");
}

function readEditor(state: State): Screen | null {
  const rows = screenRows(state);
  const bottom = labelRow(rows);
  if (bottom < 0) {
    return null;
  }
  const top = topBorder(rows, bottom);
  const { mode, pending } = labelParts(rows[bottom] ?? "");
  const label = pending === "" ? ` ${mode} ` : ` ${mode} ${pending} `;
  return {
    mode,
    pending,
    width: state.grid.size.columns,
    rows: textRows(state, top, bottom),
    cursor: { row: state.cursor.position.row - top - 1, col: state.cursor.position.column },
    clipped: isClipped(rows[top] ?? "", rows[bottom] ?? ""),
    labelAtEnd: state.grid.rowText(bottom).endsWith(label),
  };
}

const editor = extract((state: State) => readEditor(state));
const exitStatus = extract((state: State) => state.exitStatus);
/** The text the last action typed, or null for anything else. */
const lastKey = extract((state: State) => typedText(state));
const resized = extract((state: State) => {
  const action: unknown = state.lastAction;
  return typeof action === "object" && action !== null && "Resize" in action;
});

// Keys are limited to ones that stay inside the editor. Left out: "/" and "@" (autocomplete, slash
// commands), "!" (runs a shell command on submit), Tab (completion), Ctrl+C/D (exit), Ctrl+Z
// (suspend), Ctrl+G (external editor), Ctrl+V (clipboard), Ctrl+L/P/N and Shift+Tab (model and
// thinking selectors).
const PRINTABLE = CharSet.union(
  CharSet.fromRange(0x20, 0x20),
  CharSet.fromRange(0x22, 0x2e),
  CharSet.fromRange(0x30, 0x3f),
  CharSet.fromRange(0x41, 0x7e),
  CharSets.UNICODE_LATIN_EXTENDED,
  CharSets.UNICODE_CJK,
  CharSets.UNICODE_EMOTICONS,
);
const VIM_KEYS = CharSet.fromLiterals(..."iaAIoOhjklwb0$xDCudc".split(""));
const ESCAPE = CharSet.fromLiterals("\u001B");
const EDITING = CharSet.union(
  CharSet.fromLiterals(
    "\r", // Enter: submits; with no model Pi reports an error
    "\u007F", // Backspace
    "\u0001", // Ctrl+A
    "\u0005", // Ctrl+E
    "\u000B", // Ctrl+K
    "\u0015", // Ctrl+U
    "\u0017", // Ctrl+W
    "\u0019", // Ctrl+Y
    "\u001F", // Ctrl+_ (undo)
    "\u001B[H", // Home
    "\u001B[F", // End
    "\u001B[3~", // Delete
  ),
  CharSets.CONTROL_ARROWS,
  CharSets.CONTROL_ARROWS_MODIFIED,
  CharSets.CONTROL_EDITING_ALT,
);
// Characters that are neither a Normal-mode command nor the start of one.
// Listed one key each: splitting a string would cut the emoji into two lone surrogates.
const INERT = [
  ..."zqZQXYgGmMnNpPrRsStTvVeEfFyY~#%^&*()_+=-;:'\",.<>?|`".split(""),
  "漢",
  "字",
  "é",
  "😀",
];
const RESIZE = {
  Resize: { columns: [60, 140] as [number, number], rows: [20, 50] as [number, number] },
};

export const vimKeys = weighted([
  [30, typeFromSet(VIM_KEYS)],
  [20, typeFromSet(ESCAPE)],
  [10, typeFromSet(PRINTABLE)],
  [10, typeFromSet(CharSet.fromLiterals(...INERT))],
  // From idle Normal mode: clear the buffer and type a short line the model can follow.
  [8, actions(() => [{ TypeText: { Regexp: "(dd){0,2}cc([a-z]{1,5}|漢|字|😀|é| ){1,8}" } }])],
  // A line longer than any terminal width in RESIZE, so it wraps.
  [2, actions(() => [{ TypeText: { Regexp: "[a-z]{4,9}( [a-z]{4,9}){14,24}" } }])],
  [8, typeFromSet(EDITING)],
  [2, actions(() => [RESIZE])],
  [10, actions(() => [RESIZE]).when(() => (editor.current?.pending ?? "") !== "")],
  // Escape leaves the cursor on the last character, where x, dw and D act like their neighbours;
  // move it back into the line so that off-by-one edits show.
  [15, typeFromSet(CharSet.fromLiterals("0", "b", "h")).when(() => normalIdle())],
  // Start and finish the two- and three-key commands often enough for the model to check them.
  [6, typeFromSet(CharSet.fromLiterals("d", "c")).when(() => normalIdle())],
  // Lines the word commands are modelled on (lowercase and spaces), and lines of wide characters.
  [6, actions(() => [{ TypeText: { Regexp: "(dd){0,2}cc[a-z]{1,5}( [a-z]{1,5}){1,4}" } }])],
  [4, actions(() => [{ TypeText: { Regexp: "(dd){0,2}cc(漢|字|😀|[a-z]){2,6}" } }])],
  [
    10,
    typeFromSet(CharSet.fromLiterals("x", "D", "h", "l", "w", "b", "0", "$")).when(() =>
      normalIdle(),
    ),
  ],
  [
    20,
    typeFromSet(CharSet.fromLiterals("d", "c", "w", "i")).when(
      () => (editor.current?.pending ?? "") !== "",
    ),
  ],
  // `dw` and `cw` from a word start with another word after it, where an over-long delete shows.
  // Weighted well above the rest together, so most word-start states lead on to `dw` or `cw`.
  [60, typeFromSet(CharSet.fromLiterals("0", "b")).when(() => onWordLine() && !atWordStart())],
  [300, typeFromSet(CharSet.fromLiterals("d", "d", "c")).when(() => atWordStart())],
  [
    300,
    typeFromSet(CharSet.fromLiterals("w")).when(() =>
      ["d", "c"].includes(editor.current?.pending ?? ""),
    ),
  ],
]);

/** Idle Normal mode on a one-line buffer of two or more lowercase words. */
function onWordLine(): boolean {
  const screen = editor.current;
  const line = (screen?.rows[0] ?? []).join("");
  return normalIdle() && isModelState(screen) && /^[a-z ]+$/u.test(line) && /\S \S/u.test(line);
}

/** On a word line, the cursor on a word start with a later word. */
function atWordStart(): boolean {
  const screen = editor.current;
  if (screen === null || !onWordLine()) {
    return false;
  }
  const line = (screen.rows[0] ?? []).join("");
  const col = screen.cursor.col;
  const starts = /\S/u.test(line[col] ?? "") && (col === 0 || line[col - 1] === " ");
  return starts && / \S/u.test(line.slice(col));
}

// The reference model: one buffer line as graphemes, the cursor as a grapheme index.
type Line = readonly string[];
type Effect = { lines: Line[]; row: number; col: number; insert: boolean };
type Prediction = Effect & { mode: Mode; pending: string };

const graphemes = (cells: readonly string[]): string[] => cells.filter((cell) => cell !== "");
const isBlank = (line: Line, col: number): boolean => !/\S/u.test(line[col] ?? "");
const cut = (line: Line, from: number, to: number): Line => [
  ...line.slice(0, from),
  ...line.slice(to),
];
/** pi-vim's clamp: Normal mode never rests past the last character. */
const stay = (line: Line, col: number): Effect => ({
  lines: [line],
  row: 0,
  col: col > 0 && col >= line.length ? col - 1 : col,
  insert: false,
});
const enter = (line: Line, col: number): Effect => ({ lines: [line], row: 0, col, insert: true });

/** Pi's word end for lowercase words and spaces: skip spaces, then the word. */
function wordEnd(line: Line, col: number): number {
  let index = col;
  while (index < line.length && line[index] === " ") {
    index++;
  }
  while (index < line.length && line[index] !== " ") {
    index++;
  }
  return index;
}

/** Pi's previous word start for lowercase words and spaces. */
function wordStart(line: Line, col: number): number {
  let index = col;
  while (index > 0 && line[index - 1] === " ") {
    index--;
  }
  while (index > 0 && line[index - 1] !== " ") {
    index--;
  }
  return index;
}

function nextWord(line: Line, col: number): Effect {
  let index = isBlank(line, col) ? col : wordEnd(line, col);
  while (index < line.length && line[index] === " ") {
    index++;
  }
  return stay(line, index);
}

function innerWord(line: Line, col: number, insert: boolean): Effect {
  const finish = insert ? enter : stay;
  if (isBlank(line, col)) {
    return finish(line, col);
  }
  const start = wordStart(line, wordEnd(line, col));
  return finish(cut(line, start, wordEnd(line, start)), start);
}

type Command = (line: Line, col: number) => Effect | null;

/** Word commands are modelled only where Pi's word boundaries are plain: lowercase and spaces. */
const words =
  (command: Command): Command =>
  (line, col) =>
    line.every((grapheme) => /^[a-z ]$/u.test(grapheme)) ? command(line, col) : null;

// `u` depends on Pi's undo history and `j`/`k` browse prompt history from a one-line buffer, so
// neither has a screen-only prediction.
const EFFECTS: ReadonlyMap<string, Command> = new Map<string, Command>([
  ["h", (line, col) => stay(line, Math.max(0, col - 1))],
  ["l", (line, col) => stay(line, Math.min(line.length, col + 1))],
  ["0", (line) => stay(line, 0)],
  ["$", (line) => stay(line, line.length)],
  ["x", (line, col) => stay(cut(line, col, col + 1), col)],
  ["D", (line, col) => stay(line.slice(0, col), col)],
  ["C", (line, col) => enter(line.slice(0, col), col)],
  ["dd", () => stay([], 0)],
  ["cc", () => enter([], 0)],
  ["i", enter],
  ["a", (line, col) => enter(line, Math.min(line.length, col + 1))],
  ["A", (line) => enter(line, line.length)],
  ["I", (line) => enter(line, 0)],
  ["o", (line) => ({ lines: [line, []], row: 1, col: 0, insert: true })],
  ["O", (line) => ({ lines: [[], line], row: 0, col: 0, insert: true })],
  ["w", words(nextWord)],
  ["b", words((line, col) => stay(line, wordStart(line, col)))],
  ["dw", words((line, col) => stay(cut(line, col, wordEnd(line, col)), col))],
  ["cw", words((line, col) => enter(cut(line, col, wordEnd(line, col)), col))],
  ["diw", words((line, col) => innerWord(line, col, false))],
  ["ciw", words((line, col) => innerWord(line, col, true))],
  ["u", () => null],
  ["j", () => null],
  ["k", () => null],
]);
const PREFIXES: ReadonlySet<string> = new Set(["d", "c", "di", "ci"]);

function isPrintableKey(key: string): boolean {
  const code = key.codePointAt(0);
  return code !== undefined && code >= 0x20 && code !== 0x7f && String.fromCodePoint(code) === key;
}

/**
 * A non-printable key cancels a pending command and is dropped; alone it is Pi's. Pi's app
 * shortcuts on modified keys (Ctrl+Up, Alt+Up, ...) never reach the editor, so the model leaves
 * those out.
 */
function cancelsPending(pending: string, key: string): boolean {
  const appShortcut = key.includes(";") || (key.length > 1 && key[1] !== "[");
  return pending !== "" && !appShortcut;
}

const unchanged = (line: Line, col: number, pending: string): Prediction => ({
  lines: [line],
  row: 0,
  col,
  insert: false,
  mode: "NORMAL",
  pending,
});

/** Escape, control sequences and multi-character text. */
function predictNonPrintable(
  line: Line,
  col: number,
  pending: string,
  key: string,
): Prediction | null {
  if (key === "\u001B") {
    return unchanged(line, col, "");
  }
  // Typed text of several characters reaches the editor one key at a time: not one step.
  const several =
    !key.startsWith("\u001B") && String.fromCodePoint(key.codePointAt(0) ?? 0) !== key;
  return !several && cancelsPending(pending, key) ? unchanged(line, col, "") : null;
}

/** What Normal mode with `pending` typed shows after `key`, or null when the model cannot say. */
function predict(line: Line, col: number, pending: string, key: string): Prediction | null {
  if (!isPrintableKey(key)) {
    return predictNonPrintable(line, col, pending, key);
  }
  const sequence = pending + key;
  const command = EFFECTS.get(sequence);
  if (command === undefined) {
    return unchanged(line, col, PREFIXES.has(sequence) ? sequence : "");
  }
  const effect = command(line, col);
  return effect && { ...effect, mode: effect.insert ? "INSERT" : "NORMAL", pending: "" };
}

/** The graphemes drawn two cells wide in a row. */
function wideGraphemes(cells: readonly string[]): Set<string> {
  return new Set(cells.filter((cell, index) => cell !== "" && cells[index + 1] === ""));
}

function shows(after: Screen, expected: Prediction, wide: ReadonlySet<string>): boolean {
  if (
    after.mode !== expected.mode ||
    after.pending !== expected.pending ||
    after.rows.length !== expected.lines.length
  ) {
    return false;
  }
  const text = expected.lines.every(
    (line, index) =>
      graphemes(after.rows[index] ?? [])
        .join("")
        .trimEnd() === line.join("").trimEnd(),
  );
  const column = (expected.lines[expected.row] ?? [])
    .slice(0, expected.col)
    .reduce((sum, grapheme) => sum + (wide.has(grapheme) ? 2 : 1), 0);
  return text && after.cursor.row === expected.row && after.cursor.col === column;
}

/** One unwrapped, fully drawn line in Normal mode with the cursor on it. */
function isModelState(screen: Screen | null): screen is Screen {
  const cells = screen?.rows[0];
  return (
    screen !== null &&
    cells !== undefined &&
    screen.mode === "NORMAL" &&
    screen.rows.length === 1 &&
    !screen.clipped &&
    screen.cursor.row === 0 &&
    screen.cursor.col < screen.width - 1 &&
    cells[screen.cursor.col] !== ""
  );
}

/**
 * The screen cannot show trailing spaces, so the buffer is the drawn graphemes plus some number of
 * spaces that keep the line unwrapped. The step passes when the model agrees for one such count.
 */
function followsModel(before: Screen, key: string, after: Screen): boolean {
  const cells = before.rows[0] ?? [];
  const drawn = graphemes(cells);
  const wide = wideGraphemes(cells);
  const col = before.cursor.col;
  const index = graphemes(cells.slice(0, col)).length + Math.max(0, col - cells.length);
  const least = index > 0 && index >= drawn.length ? index - drawn.length + 1 : 0;
  const most = Math.max(least, before.width - 2 - cells.length);
  for (let spaces = least; spaces <= most; spaces++) {
    const line = [...drawn, ...Array.from({ length: spaces }, () => " ")];
    const expected = predict(line, index, before.pending, key);
    if (expected === null || shows(after, expected, wide)) {
      return true;
    }
  }
  return false;
}

const textOf = (screen: Screen): string =>
  screen.rows
    .map((row) => graphemes(row).join(""))
    .join("\n")
    .trim();
const compact = (screen: Screen): string => screen.rows.flat().join("").replaceAll(/\s/gu, "");
const normalIdle = (): boolean =>
  editor.current?.mode === "NORMAL" && editor.current.pending === "";

/** Pi never exits or crashes: no key in the generator asks it to. */
export const piKeepsRunning: Formula = always(() => exitStatus.current === null);

/** The editor always shows a mode label (no key in the generator opens autocomplete). */
export const modeLabelShown: Formula = always(() => editor.current !== null);

/** Escape always leaves Normal mode with nothing pending. */
export const escapeEntersNormal: Formula = always(
  () => lastKey.current !== "\u001B" || normalIdle(),
);

/**
 * From Normal mode on a one-line buffer, each key's effect on text, cursor, mode and pending
 * command matches the README's table, including keys typed after a pending `d`, `c` or `di`.
 */
export const normalModeFollowsModel: Formula = always(() => {
  const before = editor.current;
  if (!isModelState(before)) {
    return true;
  }
  return next(() => {
    const key = lastKey.current;
    const after = editor.current;
    return key === null || after === null || followsModel(before, key, after);
  });
});

/**
 * Wrapped or not, every text row fits inside the terminal less the cursor column, and the label
 * still ends the bottom border at the right edge.
 */
export const editorFitsWidth: Formula = always(() => {
  const screen = editor.current;
  return (
    screen === null ||
    (screen.labelAtEnd && screen.rows.every((row) => row.length <= screen.width - 1))
  );
});

/** A resize redraws the editor but keeps a pending command and the text. */
export const pendingSurvivesResize: Formula = always(() => {
  const before = editor.current;
  if (before === null || before.pending === "" || before.clipped) {
    return true;
  }
  return next(() => {
    const after = editor.current;
    if (!resized.current || after === null || after.clipped) {
      return true;
    }
    return (
      after.mode === "NORMAL" &&
      after.pending === before.pending &&
      compact(after) === compact(before)
    );
  });
});

/** Submitting from Normal mode empties the editor and returns to Insert mode. */
export const submitReturnsToInsert: Formula = always(() => {
  const before = editor.current;
  if (before === null || !normalIdle() || textOf(before) === "") {
    return true;
  }
  return next(() => {
    const after = editor.current;
    return (
      lastKey.current !== "\r" || after === null || textOf(after) !== "" || after.mode === "INSERT"
    );
  });
});
