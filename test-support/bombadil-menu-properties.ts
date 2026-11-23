import { always, next } from "@antithesishq/bombadil";
import type { Formula } from "@antithesishq/bombadil";
import type { MenuView } from "./bombadil-menu.ts";

const ESCAPE = "\u001B";
export type Read<T> = () => T | null | undefined;

export function escapeGoesBack<T extends MenuView>(
  view: Read<T>,
  lastKey: Read<string>,
  expected: (before: T) => readonly (string | null)[] | undefined,
): Formula {
  return always(() => {
    const before = view();
    const allowed = before?.titleShown === true ? expected(before) : undefined;
    if (allowed === undefined) {
      return true;
    }
    return next(() => lastKey() !== ESCAPE || allowed.includes(view()?.title ?? null));
  });
}

export function menuFits<T extends MenuView & { height: number }>(
  view: Read<T>,
  minRows: number,
): Formula {
  return always(() => {
    const menu = view();
    return (
      menu === null ||
      menu === undefined ||
      !(menu.titleShown || menu.hintShown) ||
      menu.height < minRows ||
      (menu.titleShown && menu.bottomShown)
    );
  });
}

export function oneHighlight<T extends MenuView>(
  view: Read<T>,
  applies: (menu: T) => boolean,
): Formula {
  return always(() => {
    const menu = view();
    return (
      menu === null ||
      menu === undefined ||
      !menu.titleShown ||
      !menu.hintShown ||
      !applies(menu) ||
      menu.cursors === 1
    );
  });
}
