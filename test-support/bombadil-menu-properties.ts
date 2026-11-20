// Property factories over the menu readers in bombadil-menu.ts. They live apart from the readers
// because @antithesishq/bombadil ships types only: Bombadil's bundler provides `always`/`next` at
// run time, so vitest can load bombadil-menu.ts but not this file.
import { always, next } from "@antithesishq/bombadil";
import type { Formula } from "@antithesishq/bombadil";
import type { MenuView } from "./bombadil-menu.ts";

const ESCAPE = "\u001B";
/** Reads the current value of an extractor cell. */
export type Read<T> = () => T | null | undefined;

/**
 * Escape on a shown menu lands on one of the titles `expected` allows for that screen (null means
 * the menu closed). `expected` returns undefined for screens the property does not judge.
 */
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

/** From `minRows` rows up, a shown menu has its title and the border directly below its hint. */
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

/** A fully shown menu screen for which `applies` holds has exactly one `→ ` row in its body. */
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
