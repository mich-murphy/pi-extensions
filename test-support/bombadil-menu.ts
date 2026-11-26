const BORDER = /^─+$/u;

export function bottomBorderBelow(rows: ReadonlyArray<string>, hint: number): boolean {
  return hint >= 0 && BORDER.test(rows[hint + 1] ?? "");
}

function bodyCursors(body: ReadonlyArray<string>): number {
  return body.filter((row) => row.startsWith("→ ")).length;
}

export type MenuLayout = {
  readonly title: RegExp;
  readonly hint: RegExp;
  readonly separator: string;
};

export type MenuView = {
  title: string | null;
  path: Array<string> | null;
  depth: number;
  hint: string | null;
  hintGroups: Record<string, string>;
  body: Array<string>;
  cursors: number;
  selected: string | null;
  titleShown: boolean;
  hintShown: boolean;
  bottomShown: boolean;
};

function titleFields(
  rows: ReadonlyArray<string>,
  top: number,
  separator: string,
): Pick<MenuView, "title" | "path" | "depth" | "titleShown"> {
  const title = top >= 0 ? (rows[top] ?? null) : null;
  const path = title === null ? null : title.split(separator);

  return { title, path, depth: path === null ? -1 : path.length - 1, titleShown: top >= 0 };
}

function selectedLabel(body: ReadonlyArray<string>): string | null {
  const cursorRow = body.find((row) => row.startsWith("→ "));

  return cursorRow === undefined ? null : (cursorRow.slice(2).split(/\s{2,}/u)[0] ?? null);
}

function hintFields(
  rows: ReadonlyArray<string>,
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

export function readMenu(rows: ReadonlyArray<string>, layout: MenuLayout): MenuView {
  const top = rows.findIndex((row) => layout.title.test(row));
  const hint = rows.findIndex((row, index) => index > top && layout.hint.test(row));
  const body = top >= 0 && hint > top ? rows.slice(top + 1, hint) : [];

  return {
    ...titleFields(rows, top, layout.separator),
    ...hintFields(rows, hint, layout.hint),
    body,
    cursors: bodyCursors(body),
    selected: selectedLabel(body),
  };
}
