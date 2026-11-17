// Bombadil terminal specification for pi-vim: random keys against the real Pi CLI in a real
// terminal emulator. Run with `npm run test:bombadil`. The Hegel tests drive the editor in-process
// through a fake terminal; this drives the real stdin parser, renderer and resize path.
//
// Every property reads only what is on screen: the mode label on the editor's bottom border, the
// grid cells between the editor's borders, and the hardware cursor Pi places at the edit point.
// Command effects are checked in-process by vim-properties.test.ts; this spec checks what only a
// real terminal shows: labels, Escape, width, resize, submit and wide-character deletes.
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
  // From idle Normal mode: clear the buffer and type a short line, some with wide characters.
  [8, actions(() => [{ TypeText: { Regexp: "(dd){0,2}cc([a-z]{1,5}|漢|字|😀|é| ){1,8}" } }])],
  [4, actions(() => [{ TypeText: { Regexp: "(dd){0,2}cc(漢|字|😀|[a-z]){2,6}" } }])],
  // A line longer than any terminal width in RESIZE, so it wraps.
  [2, actions(() => [{ TypeText: { Regexp: "[a-z]{4,9}( [a-z]{4,9}){14,24}" } }])],
  [8, typeFromSet(EDITING)],
  [2, actions(() => [RESIZE])],
  // Resize while d, c or di is pending, and start those commands often enough to get there.
  [10, actions(() => [RESIZE]).when(() => (editor.current?.pending ?? "") !== "")],
  [6, typeFromSet(CharSet.fromLiterals("d", "c")).when(() => normalIdle())],
  [10, typeFromSet(CharSet.fromLiterals("d", "c", "w", "i")).when(() => pendingShown())],
  // Escape leaves the cursor on the last character; move it back so `x` acts inside the line.
  [10, typeFromSet(CharSet.fromLiterals("0", "b", "h")).when(() => normalIdle())],
  // `x` on a wide character, where deleting half of it or a neighbour shows.
  [20, actions(towardWide).when(() => wideColumns().length > 0 && !onWide())],
  [60, typeFromSet(CharSet.fromLiterals("x")).when(() => onWide())],
]);

const graphemes = (cells: readonly string[]): string[] => cells.filter((cell) => cell !== "");
const textOf = (screen: Screen): string =>
  screen.rows
    .map((row) => graphemes(row).join(""))
    .join("\n")
    .trim();
const compact = (screen: Screen): string => screen.rows.flat().join("").replaceAll(/\s/gu, "");
const normalIdle = (): boolean =>
  editor.current?.mode === "NORMAL" && editor.current.pending === "";
const pendingShown = (): boolean => (editor.current?.pending ?? "") !== "";

/** One unwrapped, fully drawn line in idle Normal mode. */
function oneIdleLine(screen: Screen | null): screen is Screen {
  return normalIdle() && screen !== null && screen.rows.length === 1 && !screen.clipped;
}

/** On one idle line, the cursor rests on a drawn character (not a hidden trailing space). */
function onDrawnCharacter(screen: Screen | null): screen is Screen {
  if (!oneIdleLine(screen) || screen.cursor.row !== 0) {
    return false;
  }
  const cells = screen.rows[0] ?? [];
  return screen.cursor.col < cells.length && cells[screen.cursor.col] !== "";
}

/** On one idle line, the columns where a wide character starts. */
function wideColumns(): number[] {
  const screen = editor.current;
  if (!onDrawnCharacter(screen)) {
    return [];
  }
  const cells = screen.rows[0] ?? [];
  return cells.flatMap((cell, index) => (cell !== "" && cells[index + 1] === "" ? [index] : []));
}

/** The cursor rests on a wide character of one idle line. */
function onWide(): boolean {
  return wideColumns().includes(editor.current?.cursor.col ?? -1);
}

/** One step toward the nearest wide character: `l` if one lies to the right, else `h`. */
function towardWide() {
  const col = editor.current?.cursor.col ?? 0;
  const key = wideColumns().some((wide) => wide > col) ? "l" : "h";
  return [{ TypeText: { CharSet: CharSet.fromLiterals(key) } }];
}

/** Pi never exits or crashes: no key in the generator asks it to. */
export const piKeepsRunning: Formula = always(() => exitStatus.current === null);

/** The editor always shows a mode label (no key in the generator opens autocomplete). */
export const modeLabelShown: Formula = always(() => editor.current !== null);

/** Escape always leaves Normal mode with nothing pending. */
export const escapeEntersNormal: Formula = always(
  () => lastKey.current !== "\u001B" || normalIdle(),
);

/**
 * `x` removes exactly the character under the cursor, whole, however many cells it is drawn in.
 * Pi's real terminal width rules decide which cells a wide character covers.
 */
export const xDeletesOneCharacter: Formula = always(() => {
  const before = editor.current;
  if (!onDrawnCharacter(before)) {
    return true;
  }
  const cells = before.rows[0] ?? [];
  const index = graphemes(cells.slice(0, before.cursor.col)).length;
  const expected = graphemes(cells).toSpliced(index, 1).join("").trimEnd();
  return next(() => {
    const after = editor.current;
    return (
      lastKey.current !== "x" ||
      after === null ||
      graphemes(after.rows.flat()).join("").trimEnd() === expected
    );
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
