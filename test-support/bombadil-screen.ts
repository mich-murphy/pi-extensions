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

/** The index of a Pi extension dialog's hint row, or -1 when no dialog is on screen. */
function dialogHintRow(rows: readonly string[]): number {
  return rows.findIndex((row) => SELECT_HINT.test(row.trim()) || INPUT_HINT.test(row.trim()));
}

/** The kind of Pi extension dialog on screen, read from its hint row, or null. */
export function dialogKind(rows: readonly string[]): "select" | "input" | null {
  const hint = rows[dialogHintRow(rows)]?.trim();
  if (hint === undefined) {
    return null;
  }
  return SELECT_HINT.test(hint) ? "select" : "input";
}

/**
 * Whether a dialog's bottom border is drawn below its hint row. Pi's fullscreen layout cuts off the
 * bottom of content taller than the terminal, and the hint row can survive while the border goes.
 */
export function dialogBorderShown(rows: readonly string[]): boolean {
  const hint = dialogHintRow(rows);
  return hint >= 0 && rows.slice(hint + 1).some((row) => /^─+$/u.test(row.trim()));
}
