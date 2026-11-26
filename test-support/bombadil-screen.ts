import type { State } from "@antithesishq/bombadil/terminal";
import { hasProperty, isString } from "effect/Predicate";

export function screenRows(state: State): Array<string> {
  const rows: Array<string> = [];

  for (let index = 0; index < state.grid.size.rows; index++) {
    rows.push(state.grid.rowText(index).trimEnd());
  }

  return rows;
}

export function typedText(state: State): string | null {
  const action: unknown = state.lastAction;

  if (!hasProperty(action, "TypeText")) {
    return null;
  }

  const typed = action.TypeText;

  if (isString(typed)) {
    return typed;
  }

  return hasProperty(typed, "text") && isString(typed.text) ? typed.text : null;
}
