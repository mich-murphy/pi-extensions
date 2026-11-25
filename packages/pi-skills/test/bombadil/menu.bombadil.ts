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

function bottomBorderBelow(rows: readonly string[], hint: number): boolean {
  return hint >= 0 && /^─+$/u.test(rows[hint + 1] ?? "");
}

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

let wasOpen = false;
let fresh = false;
let lastRoot: string | null = null;
let closedWith: string | null = null;

function remember(menu: Menu) {
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

function tokenMatches(token: string, name: string): boolean {
  const query = token.toLowerCase();
  const text = name.toLowerCase();
  const parts = /^(?<a>[a-z]+)(?<b>\d+)$|^(?<c>\d+)(?<d>[a-z]+)$/u.exec(query)?.groups;
  const swapped =
    parts === undefined ? query : `${parts.b ?? parts.d ?? ""}${parts.a ?? parts.c ?? ""}`;
  return subsequence(query, text) || (swapped !== query && subsequence(swapped, text));
}

function searchKeeps(search: string, name: string): boolean {
  return search
    .split(/[\s/]+/u)
    .filter((token) => token !== "")
    .every((token) => tokenMatches(token, name));
}

const menuOpen = (): boolean => (ui.current?.level ?? null) !== null;
const selected = (menu: Menu | null | undefined): Item | null =>
  menu?.items.find((item) => item.selected) ?? null;
const FLIP = new Map(Object.entries({ On: "Off", Off: "On" }));

const open = actions(() =>
  menuOpen()
    ? []
    : [
        { TypeText: { Regexp: String.raw`\x15/skills` } },
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

export const skillsKeys = weighted([
  [6, open],
  [30, menuKeys],
  [1, resize],
]);

export const listReached: Formula = eventually(() => ui.current?.level === "list").within(
  30,
  "seconds",
);

export const piKeepsRunning: Formula = always(() => exitStatus.current === null);

export const menuFits: Formula = always(() => {
  const menu = ui.current;
  return (
    menu === null ||
    menu.level === null ||
    menu.height < 15 ||
    (menu.titleShown && menu.bottomShown)
  );
});

export const oneHighlight: Formula = always(() => {
  const menu = ui.current;
  return !(menu?.hintShown ?? false) || menu.noMatches || menu.cursors === 1;
});

export const toggleFlips: Formula = always(() => {
  const before = ui.current;
  const row = selected(before);
  if (
    before?.search !== "" ||
    before.clearing ||
    row === null ||
    FLIP.get(row.state) === undefined
  ) {
    return true;
  }
  return next(() => {
    const key = lastKey.current;
    const after = selected(ui.current);
    return (
      (key !== " " && key !== "\r") ||
      (after?.name === row.name && after.state === FLIP.get(row.state))
    );
  });
});

export const searchFilters: Formula = always(() => {
  const menu = ui.current;
  const search = menu?.search ?? "";
  return (menu?.items ?? []).every(
    (item) => item.name.endsWith("…") || searchKeeps(search, item.name),
  );
});

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

export const escapeGoesBack: Formula = always(() => {
  const before = ui.current;
  if (before === null || before.level === null || before.clearing) {
    return true;
  }
  const expected = before.level === "root" ? null : "root";
  return next(() => lastKey.current !== ESCAPE || (ui.current?.level ?? null) === expected);
});

export const choicesPersist: Formula = always(() => {
  const seen = memory.current;
  return (
    seen === null || !seen.fresh || seen.closedWith === null || seen.counts === seen.closedWith
  );
});
