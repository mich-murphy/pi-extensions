import type { State } from "@antithesishq/bombadil/terminal";

export function screenRows(state: State): string[] {
  const rows: string[] = [];
  for (let index = 0; index < state.grid.size.rows; index++) {
    rows.push(state.grid.rowText(index).trimEnd());
  }
  return rows;
}

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
