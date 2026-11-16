// Bombadil terminal specification for pi-vim: random keys against the real Pi CLI in a real
// terminal emulator. Run with `npm run test:bombadil`. The Hegel tests drive the editor in-process
// through a fake terminal; this drives the real stdin parser, renderer and resize path.
//
// Every property reads only what is on screen: the mode label on the editor's bottom border and
// the text between the editor's borders.
import { always, next, now } from "@antithesishq/bombadil";
import type { Formula } from "@antithesishq/bombadil";
import { CharSet } from "@antithesishq/bombadil/actions";
import { actions, extract, weighted } from "@antithesishq/bombadil/terminal";
import type { State } from "@antithesishq/bombadil/terminal";
import { CharSets, typeFromSet } from "@antithesishq/bombadil/terminal/defaults/actions";

export { noReplacementChars } from "@antithesishq/bombadil/terminal/defaults/properties";

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

export const vimKeys = weighted([
  [30, typeFromSet(VIM_KEYS)],
  [20, typeFromSet(ESCAPE)],
  [15, typeFromSet(PRINTABLE)],
  [10, typeFromSet(CharSet.fromLiterals(...INERT))],
  [5, actions(() => [{ TypeText: { Regexp: "[a-z]{2,8}( [a-z]{2,8}){0,3}" } }])],
  [10, typeFromSet(EDITING)],
  [2, actions(() => [{ Resize: { columns: [60, 140], rows: [20, 50] } }])],
]);

type Mode = { readonly mode: "INSERT" | "NORMAL"; readonly pending: string };

const LABEL = /^─.* (?<mode>INSERT|NORMAL)(?: (?<pending>\S+))?$/u;

function screenRows(state: State): string[] {
  const rows: string[] = [];
  for (let index = 0; index < state.grid.size.rows; index++) {
    rows.push(state.grid.rowText(index).trimEnd());
  }
  return rows;
}

/** The lowest row holding a border with a mode label, or -1. */
function labelRow(rows: readonly string[]): number {
  let index = rows.length - 1;
  while (index >= 0 && !LABEL.test(rows[index] ?? "")) {
    index--;
  }
  return index;
}

function parseLabel(row: string): Mode {
  const groups = LABEL.exec(row)?.groups;
  return { mode: groups?.mode === "INSERT" ? "INSERT" : "NORMAL", pending: groups?.pending ?? "" };
}

/** The editor's top border: the nearest border row above the bottom one, or -1. */
function topBorder(rows: readonly string[], bottom: number): number {
  let index = bottom - 1;
  while (index >= 0 && !(rows[index] ?? "").startsWith("─")) {
    index--;
  }
  return index;
}

/** The mode label at the right end of the editor's bottom border, or null when none is drawn. */
const editor = extract((state: State) => {
  const rows = screenRows(state);
  const bottom = labelRow(rows);
  if (bottom < 0) {
    return null;
  }
  const label = parseLabel(rows[bottom] ?? "");
  const text = rows
    .slice(topBorder(rows, bottom) + 1, bottom)
    .map((row) => row.trim())
    .join("\n")
    .trim();
  return { mode: label.mode, pending: label.pending, text };
});

const exitStatus = extract((state: State) => state.exitStatus);

/** The single key the last action typed, or null for anything else. */
const lastKey = extract((state: State) => {
  const action: unknown = state.lastAction;
  if (typeof action !== "object" || action === null || !("TypeText" in action)) {
    return null;
  }
  const typed: unknown = action.TypeText;
  if (typeof typed === "string") {
    return typed;
  }
  if (typeof typed === "object" && typed !== null && "text" in typed) {
    return typeof typed.text === "string" ? typed.text : null;
  }
  return null;
});

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

/** From idle Normal mode, `i` enters Insert mode. */
export const iEntersInsert: Formula = always(
  now(normalIdle).implies(next(() => lastKey.current !== "i" || editor.current?.mode === "INSERT")),
);

/** From idle Normal mode, a key that is no command leaves the text alone and stays in Normal. */
export const inertKeysDoNothing: Formula = always(() => {
  const before = editor.current;
  if (before === null || !normalIdle()) {
    return true;
  }
  return next(() => {
    const key = lastKey.current;
    if (key === null || !INERT.includes(key)) {
      return true;
    }
    return editor.current?.text === before.text && normalIdle();
  });
});

/** Submitting from Normal mode empties the editor and returns to Insert mode. */
export const submitReturnsToInsert: Formula = always(() => {
  const before = editor.current;
  if (before === null || !normalIdle() || before.text === "") {
    return true;
  }
  return next(
    () =>
      lastKey.current !== "\r" || editor.current?.text !== "" || editor.current.mode === "INSERT",
  );
});
