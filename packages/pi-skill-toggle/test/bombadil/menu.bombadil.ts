// Bombadil terminal specification for the /skill-toggle menu, run against the real Pi CLI with
// menu.fixture.ts. Run with `npm run test:bombadil:skills`. menu.test.ts drives the component
// in-process at fixed widths; this drives Pi's real input parser, layout, resize path and the state
// file on disk. Every property reads only the screen.
import { always, eventually, next } from "@antithesishq/bombadil";
import type { Formula } from "@antithesishq/bombadil";
import { CharSet } from "@antithesishq/bombadil/actions";
import { actions, extract, weighted } from "@antithesishq/bombadil/terminal";
import type { State } from "@antithesishq/bombadil/terminal";
import { typeFromSet } from "@antithesishq/bombadil/terminal/defaults/actions";
import { screenRows, typedText } from "../../../../test-support/bombadil-screen.ts";

export { noReplacementChars } from "@antithesishq/bombadil/terminal/defaults/properties";

const ESCAPE = "\u001B";
const GROUPS = "Global instructions|Global skills|Project instructions|Project skills";
const ROOT_TITLE = "Context";
const LIST_TITLE = new RegExp(`^(?:${GROUPS})(?: · .+)?$`, "u");
const ROOT_HINT = /^Enter open · Esc close$/u;
const LIST_HINT = /^(?:Type to search · )?Enter toggle · Esc (?<cancel>back|clear)$/u;
const COUNT = new RegExp(`^(?:→ )?(${GROUPS})\\s{2,}(\\S.*)$`, "u");
const ITEM =
  /^(?<cursor>→ )?(?<name>\S+)\s{2,}(?<state>On|Off|Always on|Manual only)(?:\s{2,}.*)?$/u;

type Item = { name: string; state: string; selected: boolean };
type Menu = {
  level: "root" | "list" | null;
  titleShown: boolean;
  hintShown: boolean;
  /** The menu's bottom border, directly below the hint row. */
  bottomShown: boolean;
  clearing: boolean;
  height: number;
  cursors: number;
  noMatches: boolean;
  search: string | null;
  items: Item[];
  counts: string;
};

function level(rows: readonly string[], top: number, hint: number): Menu["level"] {
  if (top >= 0) {
    return rows[top] === ROOT_TITLE ? "root" : "list";
  }
  if (hint >= 0) {
    return ROOT_HINT.test(rows[hint] ?? "") ? "root" : "list";
  }
  return null;
}

function items(body: readonly string[]): Item[] {
  return body.flatMap((row) => {
    const groups = ITEM.exec(row)?.groups;
    return groups === undefined
      ? []
      : [
          {
            name: groups.name ?? "",
            state: groups.state ?? "",
            selected: groups.cursor !== undefined,
          },
        ];
  });
}

/** Whether the row below the hint row is the menu's bottom border. */
function bottomBorderBelow(rows: readonly string[], hint: number): boolean {
  return hint >= 0 && /^─+$/u.test(rows[hint + 1] ?? "");
}

/** What the menu shows, from trimmed screen rows. Rows outside the menu are ignored. */
function readMenu(rows: readonly string[], height: number): Menu {
  const top = rows.findIndex((row) => row === ROOT_TITLE || LIST_TITLE.test(row));
  const hint = rows.findIndex((row) => ROOT_HINT.test(row) || LIST_HINT.test(row));
  const body = rows.slice(Math.max(0, top), hint === -1 ? rows.length : hint);
  const shown = level(rows, top, hint);
  const searchRow = shown === "list" ? body.find((row) => /^>(?: |$)/u.test(row)) : undefined;
  return {
    level: shown,
    titleShown: top >= 0,
    hintShown: hint >= 0,
    bottomShown: bottomBorderBelow(rows, hint),
    clearing: LIST_HINT.exec(rows[hint] ?? "")?.groups?.cancel === "clear",
    height,
    cursors: body.filter((row) => row.startsWith("→ ")).length,
    noMatches: body.includes("No matches"),
    search: searchRow === undefined ? null : searchRow.slice(1).trim(),
    items: shown === "list" ? items(body) : [],
    counts:
      shown === "root"
        ? body.flatMap((row) => COUNT.exec(row)?.slice(1, 3).join("=") ?? []).join(";")
        : "",
  };
}

const menuNow = (state: State): Menu =>
  readMenu(
    screenRows(state).map((row) => row.trim()),
    state.grid.size.rows,
  );

// The group counts last seen on the main screen, and when the menu closed. Updates are idempotent,
// so evaluating one state twice changes nothing.
let wasOpen = false;
let fresh = false;
let lastRoot: string | null = null;
let closedWith: string | null = null;

/** The main screen's counts, flagged `fresh` until a list is opened after a reopen. */
function remember(menu: Menu): { fresh: boolean; counts: string; closedWith: string | null } {
  if (menu.level === null) {
    if (wasOpen) {
      closedWith = lastRoot;
    }
    wasOpen = false;
    fresh = false;
  } else if (menu.level === "list") {
    wasOpen = true;
    fresh = false;
  } else {
    fresh ||= !wasOpen;
    wasOpen = true;
    lastRoot = menu.counts;
  }
  return { fresh, counts: menu.counts, closedWith };
}

const ui = extract((state: State) => menuNow(state));
const memory = extract((state: State) => remember(menuNow(state)));
const exitStatus = extract((state: State) => state.exitStatus);
const lastKey = extract((state: State) => typedText(state));

function subsequence(query: string, text: string): boolean {
  let at = 0;
  for (const char of query) {
    at = text.indexOf(char, at);
    if (at === -1) {
      return false;
    }
    at += char.length;
  }
  return true;
}

/** pi-tui's fuzzyMatch: in-order characters, or letters and digits swapped. */
function tokenMatches(token: string, name: string): boolean {
  const query = token.toLowerCase();
  const text = name.toLowerCase();
  const parts = /^(?<a>[a-z]+)(?<b>\d+)$|^(?<c>\d+)(?<d>[a-z]+)$/u.exec(query)?.groups;
  const swapped =
    parts === undefined ? query : `${parts.b ?? parts.d ?? ""}${parts.a ?? parts.c ?? ""}`;
  return subsequence(query, text) || (swapped !== query && subsequence(swapped, text));
}

/** Whether pi-tui's fuzzyFilter keeps `name` for `search`. */
function searchKeeps(search: string, name: string): boolean {
  return search
    .split(/[\s/]+/u)
    .filter((token) => token !== "")
    .every((token) => tokenMatches(token, name));
}

const menuOpen = (): boolean => (ui.current?.level ?? null) !== null;
const selected = (menu: Menu | null | undefined): Item | null =>
  menu?.items.find((item) => item.selected) ?? null;
const FLIP: Readonly<Record<string, string>> = { On: "Off", Off: "On" };

// Closed: clear the editor and run the command. The first Enter may only accept autocomplete.
const open = actions(() =>
  menuOpen()
    ? []
    : [
        { TypeText: { Regexp: String.raw`\x15/skill-toggle` } },
        { TypeText: { CharSet: CharSet.fromLiterals("\r") } },
      ],
);

const NAVIGATE = CharSet.fromLiterals("\u001B[A", "\u001B[B", "j", "k", "\u001B[5~", "\u001B[6~");
const SEARCH = CharSet.fromLiterals(..."abcdeghiklmnoprstuz-".split(""), "漢", "研");
const menuKeys = weighted([
  [30, typeFromSet(NAVIGATE)],
  [20, typeFromSet(CharSet.fromLiterals(" ", "\r"))],
  [8, typeFromSet(CharSet.fromLiterals(ESCAPE))],
  [10, typeFromSet(SEARCH)],
  [4, actions(() => [{ TypeText: { Regexp: "[a-z]{1,4}" } }])],
  [8, typeFromSet(CharSet.fromLiterals("\u007F"))],
]).when(menuOpen);

const resize = actions(() => [{ Resize: { columns: [60, 160], rows: [15, 50] } }]);

export const skillToggleKeys = weighted([
  [6, open],
  [30, menuKeys],
  [1, resize],
]);

/**
 * The fuzzer opens the menu and a list. Both are recognised by their title and hint text, so if that
 * text changes the menu properties would pass without checking anything; this fails instead.
 */
export const listReached: Formula = eventually(() => ui.current?.level === "list").within(
  30,
  "seconds",
);

/** Pi never exits: no key in the generator asks it to. */
export const piKeepsRunning: Formula = always(() => exitStatus.current === null);

/**
 * From 15 rows up, an open menu shows its title, its key hint and its bottom border: nothing is
 * cut off by Pi's fullscreen layout.
 */
export const menuFits: Formula = always(() => {
  const menu = ui.current;
  return (
    menu === null ||
    menu.level === null ||
    menu.height < 15 ||
    (menu.titleShown && menu.bottomShown)
  );
});

/** An open menu highlights exactly one row, unless a search matches nothing. */
export const oneHighlight: Formula = always(() => {
  const menu = ui.current;
  return !(menu?.hintShown ?? false) || menu.noMatches || menu.cursors === 1;
});

/** Space or Enter with an empty search flips the selected On/Off row and keeps it selected. */
export const toggleFlips: Formula = always(() => {
  const before = ui.current;
  const row = selected(before);
  if (before?.search !== "" || before.clearing || row === null || FLIP[row.state] === undefined) {
    return true;
  }
  return next(() => {
    const key = lastKey.current;
    const after = selected(ui.current);
    return (
      (key !== " " && key !== "\r") || (after?.name === row.name && after.state === FLIP[row.state])
    );
  });
});

/** While searching, every fully shown row matches the search. */
export const searchFilters: Formula = always(() => {
  const menu = ui.current;
  const search = menu?.search ?? "";
  return (menu?.items ?? []).every(
    (item) => item.name.endsWith("…") || searchKeeps(search, item.name),
  );
});

/** Escape with a search clears it, stays in the list and shows at least as many rows. */
export const escapeClearsSearch: Formula = always(() => {
  const before = ui.current;
  if (before?.level !== "list" || !before.clearing) {
    return true;
  }
  return next(
    () =>
      lastKey.current !== ESCAPE ||
      (ui.current?.level === "list" &&
        !ui.current.clearing &&
        ui.current.items.length >= before.items.length),
  );
});

/** Escape without a search goes back a level: from a list to the main screen, then closed. */
export const escapeGoesBack: Formula = always(() => {
  const before = ui.current;
  if (before === null || before.level === null || before.clearing) {
    return true;
  }
  const expected = before.level === "root" ? null : "root";
  return next(() => lastKey.current !== ESCAPE || (ui.current?.level ?? null) === expected);
});

/** A reopened menu shows the group counts it showed when it closed: every toggle was saved. */
export const choicesPersist: Formula = always(() => {
  const seen = memory.current;
  return (
    seen === null || !seen.fresh || seen.closedWith === null || seen.counts === seen.closedWith
  );
});
