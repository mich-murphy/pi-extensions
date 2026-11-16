// Screen helpers shared by the Bombadil specifications in packages/<name>/test/bombadil/.
// Bombadil runs extractors with module-level helpers in scope, so these are plain functions.
import type { State } from "@antithesishq/bombadil/terminal";

/** Every visible row's text, with trailing spaces removed. */
export function screenRows(state: State): string[] {
  const rows: string[] = [];
  for (let index = 0; index < state.grid.size.rows; index++) {
    rows.push(state.grid.rowText(index).trimEnd());
  }
  return rows;
}

/** The text the last action typed, or null when the last action typed nothing. */
export function typedText(state: State): string | null {
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
}

// Pi's select and input dialogs end with one of these hint rows; they mark an open dialog.
const SELECT_HINT = /^↑↓ navigate {2}enter select {2}escape\/ctrl\+c cancel$/u;
const INPUT_HINT = /^enter submit {2}escape\/ctrl\+c cancel$/u;

/** The kind of Pi extension dialog on screen, read from its hint row, or null. */
export function dialogKind(rows: readonly string[]): "select" | "input" | null {
  if (rows.some((row) => SELECT_HINT.test(row.trim()))) {
    return "select";
  }
  return rows.some((row) => INPUT_HINT.test(row.trim())) ? "input" : null;
}
