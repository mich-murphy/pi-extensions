import { always, eventually } from "@antithesishq/bombadil";
import type { Formula } from "@antithesishq/bombadil";
import { CharSet } from "@antithesishq/bombadil/actions";
import { actions, extract, weighted } from "@antithesishq/bombadil/terminal";
import type { State } from "@antithesishq/bombadil/terminal";
import { typeFromSet } from "@antithesishq/bombadil/terminal/defaults/actions";
import { screenRows } from "../../../../test-support/bombadil-screen.ts";
import { PROMPTS } from "./scroll-prompts.ts";

export { noReplacementChars } from "@antithesishq/bombadil/terminal/defaults/properties";

const LINE = CharSet.fromLiterals("\u001B[17~", "\u001B[18~");
const PAGE = CharSet.fromLiterals("\u001B[5~", "\u001B[6~", "\u001B[21~", "\u001B[23~");
const ENDS = CharSet.fromLiterals("\u001B[19~", "\u001B[20~");

export const scrollActions = weighted([
  [25, typeFromSet(LINE)],
  [15, typeFromSet(PAGE)],
  [5, typeFromSet(ENDS)],
  [4, actions(() => [{ TypeText: { Regexp: "[a-z]{1,6}( [a-z]{1,6}){0,2}" } }])],
  [2, typeFromSet(CharSet.fromLiterals("\u0015"))],
  [3, actions(() => [{ Resize: { columns: [40, 160], rows: [15, 50] } }])],
]);

const CONTEXT = /^❯ P(?<turn>\d\d):/u;
const PROMPT_ROW = /^\s*P(?<turn>\d\d):/u;
const REPLY_ROW = /^\s*T(?<turn>\d\d)L\d{3}/u;

type Marker = { readonly kind: "prompt" | "reply"; readonly turn: number };

type View = {
  readonly columns: number;
  readonly context: string | null;
  readonly contextTurn: number;
  readonly contextRows: number;
  readonly transcript: string[];
  readonly behind: boolean;
};

function marker(row: string): Marker | null {
  const prompt = PROMPT_ROW.exec(row)?.groups?.turn;
  if (prompt !== undefined) {
    return { kind: "prompt", turn: Number(prompt) };
  }
  const reply = REPLY_ROW.exec(row)?.groups?.turn;
  return reply === undefined ? null : { kind: "reply", turn: Number(reply) };
}

function readView(state: State): View | null {
  if (state.scrollOffset !== 0) {
    return null;
  }
  const rows = screenRows(state);
  const first = rows[0] ?? "";
  const context = CONTEXT.test(first) ? first : null;
  const editorTop = rows.findIndex((row) => row.startsWith("─"));
  return {
    columns: state.grid.size.columns,
    context,
    contextTurn: Number(CONTEXT.exec(first)?.groups?.turn ?? "0"),
    contextRows: rows.filter((row) => row.includes("❯ P") && /❯ P\d\d:/u.test(row)).length,
    transcript: rows.slice(context === null ? 0 : 1, editorTop < 0 ? rows.length : editorTop),
    behind: rows.some((row) => row.includes("Jump to latest message")),
  };
}

const view = extract((state: State) => readView(state));
const exitStatus = extract((state: State) => state.exitStatus);

const squash = (text: string): string => text.replaceAll(/\s+/gu, "");

function firstMarker(transcript: readonly string[]): Marker | null {
  for (const row of transcript) {
    const found = marker(row);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

export const piKeepsRunning: Formula = always(() => exitStatus.current === null);

export const contextRowOnlyAtTop: Formula = always(() => {
  const current = view.current;
  return current === null || current.contextRows === (current.context === null ? 0 : 1);
});

export const contextRowTruncatesToWidth: Formula = always(() => {
  const current = view.current;
  if (current === null || current.context === null) {
    return true;
  }
  const full = squash(`❯ ${PROMPTS[current.contextTurn - 1] ?? ""}`);
  const shown = current.context;
  if (!shown.endsWith("…")) {
    return squash(shown) === full;
  }
  const kept = squash(shown.slice(0, -1));
  return kept.length < full.length && full.startsWith(kept);
});

export const contextIsNearestPromptAbove: Formula = always(() => {
  const current = view.current;
  if (current === null || current.context === null) {
    return true;
  }
  const found = firstMarker(current.transcript);
  if (found === null) {
    return true;
  }
  return current.contextTurn === (found.kind === "reply" ? found.turn : found.turn - 1);
});

export const scrolledBackReached: Formula = eventually(() => view.current?.behind ?? false).within(
  30,
  "seconds",
);

export const hiddenAtLiveEnd: Formula = always(() => {
  const current = view.current;
  return current === null || current.behind || current.context === null;
});

export const shownOverReply: Formula = always(() => {
  const current = view.current;
  if (current === null || !current.behind) {
    return true;
  }
  const top = marker(current.transcript[0] ?? "");
  return top?.kind !== "reply" || current.contextTurn === top.turn;
});
