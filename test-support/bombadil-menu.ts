// Screen readers for menus drawn between two DynamicBorder rows: a title row, a body, a key-hint
// row and the bottom border directly below the hint. Used by the Bombadil specifications in
// packages/<name>/test/bombadil/. These are plain functions over trimmed rows, so vitest can check
// them against synthetic screens and Bombadil can run them inside extractors.

const BORDER = /^─+$/u;

/** Whether the row directly below the hint row is a border: nothing below the hint is cut off. */
export function bottomBorderBelow(rows: readonly string[], hint: number): boolean {
  return hint >= 0 && BORDER.test(rows[hint + 1] ?? "");
}

/** How many body rows carry SettingsList's `→ ` cursor. Rows outside the menu are not counted. */
function bodyCursors(body: readonly string[]): number {
  return body.filter((row) => row.startsWith("→ ")).length;
}

/** How to find one menu on screen. `separator` splits a breadcrumb title into its segments. */
export type MenuShape = {
  readonly title: RegExp;
  readonly hint: RegExp;
  readonly separator: string;
};

/** What a menu shows. `depth` is the breadcrumb segment count minus one, or -1 without a title. */
export type MenuView = {
  title: string | null;
  path: string[] | null;
  depth: number;
  hint: string | null;
  hintGroups: Record<string, string>;
  body: string[];
  cursors: number;
  selected: string | null;
  titleShown: boolean;
  hintShown: boolean;
  bottomShown: boolean;
};

/** The breadcrumb title, its segments and depth (-1 without a title). */
function titleFields(
  rows: readonly string[],
  top: number,
  separator: string,
): Pick<MenuView, "title" | "path" | "depth" | "titleShown"> {
  const title = top >= 0 ? (rows[top] ?? null) : null;
  const path = title === null ? null : title.split(separator);
  return { title, path, depth: path === null ? -1 : path.length - 1, titleShown: top >= 0 };
}

/** The label of the body row carrying SettingsList's `→ ` cursor, or null. */
function selectedLabel(body: readonly string[]): string | null {
  const cursorRow = body.find((row) => row.startsWith("→ "));
  return cursorRow === undefined ? null : (cursorRow.slice(2).split(/\s{2,}/u)[0] ?? null);
}

/** The hint row, its named groups, and whether the bottom border follows it. */
function hintFields(
  rows: readonly string[],
  hint: number,
  pattern: RegExp,
): Pick<MenuView, "hint" | "hintGroups" | "hintShown" | "bottomShown"> {
  const row = hint >= 0 ? (rows[hint] ?? null) : null;
  return {
    hint: row,
    hintGroups: { ...pattern.exec(row ?? "")?.groups },
    hintShown: hint >= 0,
    bottomShown: bottomBorderBelow(rows, hint),
  };
}

/**
 * Reads a menu from trimmed screen rows. The hint is the first hint-shaped row below the title (or
 * anywhere when the title is cut off); the body is everything strictly between them.
 */
export function readMenu(rows: readonly string[], shape: MenuShape): MenuView {
  const top = rows.findIndex((row) => shape.title.test(row));
  const hint = rows.findIndex((row, index) => index > top && shape.hint.test(row));
  const body = top >= 0 && hint > top ? rows.slice(top + 1, hint) : [];
  return {
    ...titleFields(rows, top, shape.separator),
    ...hintFields(rows, hint, shape.hint),
    body,
    cursors: bodyCursors(body),
    selected: selectedLabel(body),
  };
}
