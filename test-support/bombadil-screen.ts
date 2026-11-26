import type { State } from "@antithesishq/bombadil/terminal";
import { Schema } from "effect";

export function screenRows(state: State): Array<string> {
  const rows: Array<string> = [];

  for (let index = 0; index < state.grid.size.rows; index++) {
    rows.push(state.grid.rowText(index).trimEnd());
  }

  return rows;
}

const hasTypeText = Schema.is(
  Schema.Struct({
    TypeText: Schema.Union([Schema.String, Schema.Struct({ text: Schema.String })]),
  }),
);

export function typedText(state: State): string | null {
  const action = state.lastAction;

  if (!hasTypeText(action)) {
    return null;
  }

  return typeof action.TypeText === "string" ? action.TypeText : action.TypeText.text;
}
