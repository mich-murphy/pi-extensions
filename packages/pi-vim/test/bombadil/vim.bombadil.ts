import { always, next } from "@antithesishq/bombadil";
import type { Formula } from "@antithesishq/bombadil";
import { CharSet } from "@antithesishq/bombadil/actions";
import { actions, extract, weighted } from "@antithesishq/bombadil/terminal";
import type { State } from "@antithesishq/bombadil/terminal";
import { CharSets, typeFromSet } from "@antithesishq/bombadil/terminal/defaults/actions";
import { screenRows, typedText } from "../../../../test-support/bombadil-screen.ts";

export { noReplacementChars } from "@antithesishq/bombadil/terminal/defaults/properties";

type Mode = "INSERT" | "NORMAL";

type Screen = {
  mode: Mode;
  pending: string;
  width: number;
  rows: string[][];
  cursor: { row: number; col: number };
  clipped: boolean;
  labelAtEnd: boolean;
};

const LABEL = /^─.* (?<mode>INSERT|NORMAL)(?: (?<pending>\S+))?$/u;

function labelRow(rows: readonly string[]): number {
  let index = rows.length - 1;
  while (index >= 0 && !LABEL.test(rows[index] ?? "")) {
    index--;
  }
  return index;
}

function topBorder(rows: readonly string[], bottom: number): number {
  let index = bottom - 1;
  while (index >= 0 && !(rows[index] ?? "").startsWith("─")) {
    index--;
  }
  return index;
}

function rowCells(state: State, index: number): string[] {
  const cells = state.grid.row(index).map((cell) => cell.contents);
  while (cells.length > 0 && cells.at(-1) === " ") {
    cells.pop();
  }
  return cells;
}

function labelParts(row: string): { mode: Mode; pending: string } {
  const groups = LABEL.exec(row)?.groups;
  return { mode: groups?.mode === "INSERT" ? "INSERT" : "NORMAL", pending: groups?.pending ?? "" };
}

function textRows(state: State, top: number, bottom: number): string[][] {
  const text: string[][] = [];
  for (let index = top + 1; index < bottom; index++) {
    text.push(rowCells(state, index));
  }
  return text;
}

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
const lastKey = extract((state: State) => typedText(state));
const resized = extract((state: State) => {
  const action: unknown = state.lastAction;
  return typeof action === "object" && action !== null && "Resize" in action;
});

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
const EDITING_KEYS = {
  enterSubmitsAndReportsMissingModel: "\r",
  backspace: "\u007F",
  ctrlA: "\u0001",
  ctrlE: "\u0005",
  ctrlK: "\u000B",
  ctrlU: "\u0015",
  ctrlW: "\u0017",
  ctrlY: "\u0019",
  ctrlUnderscoreUndo: "\u001F",
  home: "\u001B[H",
  end: "\u001B[F",
  delete: "\u001B[3~",
};
const EDITING = CharSet.union(
  CharSet.fromLiterals(...Object.values(EDITING_KEYS)),
  CharSets.CONTROL_ARROWS,
  CharSets.CONTROL_ARROWS_MODIFIED,
  CharSets.CONTROL_EDITING_ALT,
);
const INERT_WHOLE_CHARACTERS_NEVER_SPLIT_INTO_SURROGATES = [
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
  [10, typeFromSet(CharSet.fromLiterals(...INERT_WHOLE_CHARACTERS_NEVER_SPLIT_INTO_SURROGATES))],
  [8, actions(() => [{ TypeText: { Regexp: "(dd){0,2}cc([a-z]{1,5}|漢|字|😀|é| ){1,8}" } }])],
  [4, actions(() => [{ TypeText: { Regexp: "(dd){0,2}cc(漢|字|😀|[a-z]){2,6}" } }])],
  [2, actions(() => [{ TypeText: { Regexp: "[a-z]{4,9}( [a-z]{4,9}){14,24}" } }])],
  [8, typeFromSet(EDITING)],
  [2, actions(() => [RESIZE])],
  [10, actions(() => [RESIZE]).when(() => (editor.current?.pending ?? "") !== "")],
  [6, typeFromSet(CharSet.fromLiterals("d", "c")).when(() => normalIdle())],
  [10, typeFromSet(CharSet.fromLiterals("d", "c", "w", "i")).when(() => pendingShown())],
  [10, typeFromSet(CharSet.fromLiterals("0", "b", "h")).when(() => normalIdle())],
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

function oneIdleLine(screen: Screen | null): screen is Screen {
  return normalIdle() && screen !== null && screen.rows.length === 1 && !screen.clipped;
}

function onDrawnCharacter(screen: Screen | null): screen is Screen {
  if (!oneIdleLine(screen) || screen.cursor.row !== 0) {
    return false;
  }
  const cells = screen.rows[0] ?? [];
  return screen.cursor.col < cells.length && cells[screen.cursor.col] !== "";
}

function wideColumns(): number[] {
  const screen = editor.current;
  if (!onDrawnCharacter(screen)) {
    return [];
  }
  const cells = screen.rows[0] ?? [];
  return cells.flatMap((cell, index) => (cell !== "" && cells[index + 1] === "" ? [index] : []));
}

function onWide(): boolean {
  return wideColumns().includes(editor.current?.cursor.col ?? -1);
}

function towardWide() {
  const col = editor.current?.cursor.col ?? 0;
  const key = wideColumns().some((wide) => wide > col) ? "l" : "h";
  return [{ TypeText: { CharSet: CharSet.fromLiterals(key) } }];
}

export const piKeepsRunning: Formula = always(() => exitStatus.current === null);

export const modeLabelShown: Formula = always(() => editor.current !== null);

export const escapeEntersNormal: Formula = always(
  () => lastKey.current !== "\u001B" || normalIdle(),
);

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

export const editorFitsWidth: Formula = always(() => {
  const screen = editor.current;
  return (
    screen === null ||
    (screen.labelAtEnd && screen.rows.every((row) => row.length <= screen.width - 1))
  );
});

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
