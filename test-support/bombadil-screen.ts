import type { State } from "@antithesishq/bombadil/terminal";
import { Schema } from "effect";

export function screenRows(state: State): string[] {
  const rows: string[] = [];
  for (let index = 0; index < state.grid.size.rows; index++) {
    rows.push(state.grid.rowText(index).trimEnd());
  }
  return rows;
}

const isText = Schema.is(Schema.String);
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
  return isText(action.TypeText) ? action.TypeText : action.TypeText.text;
}
