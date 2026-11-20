/**
 * Pure screen-stack model for the `/peers` menu. Both drivers (TUI host and RPC) render the same
 * model, so navigation and consent rules live here and nowhere else.
 *
 * How to add a screen: build a `Screen` value and return it from a row whose activation is
 * `{ kind: "open", screen }`. Its `title` is one breadcrumb segment; the model joins the stack's
 * segments with ` › `. `back()` pops exactly one screen; at the root it closes the menu.
 *
 * How to add a consent row: give a row `{ kind: "consent", action, run }`. Only build such a row
 * when the effect is Ready (validated plan, acquisition not blocked); otherwise show the reason
 * with `{ kind: "none" }`. The model calls `observe.consented(action)` synchronously, before
 * `run`, so tests and probes see consent strictly before any effect. Nothing else runs effects.
 *
 * A text editor's `save` may return a promise (a read-only preview such as reading a public offer
 * file); the editor stays open, marked busy, until it settles. An asynchronous save returns a
 * `commit` function instead of changing the draft itself: the model calls it only if that editor is
 * still on top, so Esc during the save commits nothing. Asynchronous work calls `refresh()` so the
 * TUI host rerenders.
 */
export type Consent = { consented: (action: string) => void };

/** A consent guard: when `canAct()` is false, a consent row shows `busy` and runs nothing. */
export type ActGuard = { readonly canAct: () => boolean; readonly busy: string };

/** A save's result: an inline error, a commit to apply while the editor is on top, or done. */
export type Saved = string | (() => void) | undefined;

export type Activation =
  | { readonly kind: "open"; readonly screen: () => Screen }
  | { readonly kind: "cycle"; readonly next: () => void }
  | { readonly kind: "consent"; readonly action: string; readonly run: () => void }
  | { readonly kind: "none" };

export type Row = {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly description?: string;
  readonly activation: Activation;
};

export type ToggleItem = {
  readonly id: string;
  readonly label: string;
  readonly on: boolean;
  readonly description?: string;
};

export type Screen =
  | {
      readonly kind: "list";
      readonly title: string;
      readonly note?: string;
      readonly rows: () => readonly Row[];
    }
  | {
      readonly kind: "text";
      readonly title: string;
      readonly description?: string;
      readonly value: () => string;
      readonly placeholder: string;
      /** Returns an inline error, a commit function, or undefined when the value was saved. */
      readonly save: (value: string) => Saved | Promise<Saved>;
    }
  | {
      readonly kind: "toggle";
      readonly title: string;
      readonly items: () => readonly ToggleItem[];
      readonly toggle: (id: string) => void;
    }
  | { readonly kind: "report"; readonly title: string; readonly lines: () => readonly string[] }
  | {
      readonly kind: "progress";
      readonly title: string;
      readonly lines: () => readonly string[];
      readonly done: Promise<void>;
    }
  | { readonly kind: "outcome"; readonly title: string; readonly lines: () => readonly string[] };

export class MenuModel {
  private readonly stack: Screen[];
  private open = true;
  /** The last inline validation error on the top screen; cleared on navigation. */
  error: string | undefined;
  /** True once a consent row ran. */
  acted = false;
  /** True while a text editor's asynchronous save runs. */
  busy = false;
  /** Set by a driver; called when asynchronous work changed what is shown. */
  onRefresh: (() => void) | undefined;

  constructor(
    private readonly root: Screen,
    private readonly observe?: Consent,
    private readonly guard?: ActGuard,
  ) {
    this.stack = [root];
  }

  get closed(): boolean {
    return !this.open;
  }

  get depth(): number {
    return this.stack.length - 1;
  }

  get top(): Screen {
    return this.stack.at(-1) ?? this.root;
  }

  title(): string {
    return this.stack.map((screen) => screen.title).join(" › ");
  }

  push(screen: Screen): void {
    this.stack.push(screen);
    this.error = undefined;
  }

  /** Swap the top screen (progress → outcome) without changing depth. */
  replace(screen: Screen): void {
    this.stack.splice(-1, 1, screen);
    this.error = undefined;
  }

  refresh(): void {
    this.onRefresh?.();
  }

  close(): void {
    this.open = false;
  }

  /** Esc: one level back; the outcome returns to the root; progress hides; the root closes. */
  back(): void {
    this.error = undefined;
    this.busy = false;
    const kind = this.top.kind;
    if (this.stack.length <= 1 || kind === "progress") {
      this.open = false;
    } else if (kind === "outcome") {
      this.stack.splice(1);
    } else {
      this.stack.pop();
    }
  }

  activate(id: string): void {
    const screen = this.top;
    const row = screen.kind === "list" ? screen.rows().find((item) => item.id === id) : undefined;
    if (row !== undefined) {
      this.activateRow(row);
    }
  }

  /** Runs the row that was shown and chosen (RPC captures it, rather than re-reading the rows). */
  activateRow(row: Row): void {
    if (this.top.kind !== "list" || this.closed) {
      return;
    }
    const { activation } = row;
    this.error = undefined;
    switch (activation.kind) {
      case "open": {
        this.push(activation.screen());
        break;
      }
      case "cycle": {
        activation.next();
        break;
      }
      case "consent": {
        if (this.guard?.canAct() === false) {
          this.error = this.guard.busy;
          return;
        }
        this.observe?.consented(activation.action);
        this.acted = true;
        activation.run();
        break;
      }
      case "none": {
        // A row that does nothing says why (RPC shows it above the list).
        this.error = row.description;
        break;
      }
    }
  }

  /**
   * Text editor Enter: an invalid value stays on screen with an inline error. A synchronous save
   * settles before this returns; an asynchronous one settles when the returned promise does, and
   * only if its editor is still on top (Esc meanwhile wins).
   */
  async submit(value: string): Promise<void> {
    const screen = this.top;
    if (screen.kind !== "text" || this.busy) {
      return;
    }
    const result = screen.save(value);
    if (!(result instanceof Promise)) {
      this.settle(screen, result);
      return;
    }
    this.busy = true;
    this.refresh();
    let saved: Saved;
    try {
      saved = await result;
    } catch {
      saved = "That could not be checked.";
    } finally {
      this.busy = false;
    }
    this.settle(screen, saved);
    this.refresh();
  }

  /** Applies a save only while its editor is still on top; Esc meanwhile discards it. */
  private settle(screen: Screen, saved: Saved): void {
    if (this.top !== screen || this.closed) {
      return;
    }
    if (typeof saved === "string") {
      this.error = saved;
      return;
    }
    saved?.();
    this.back();
  }

  toggle(id: string): void {
    const screen = this.top;
    if (screen.kind === "toggle") {
      screen.toggle(id);
    }
  }
}

export type KeyNames = { readonly confirm: string; readonly cancel: string };

/** The screen contract's hint row; key names come from the injected keybindings. */
export function hint(screen: Screen, depth: number, keys: KeyNames): string {
  const { confirm, cancel } = keys;
  const hints: Record<Screen["kind"], string> = {
    list: `${confirm} select · ${cancel} ${depth === 0 ? "close" : "back"}`,
    text: `${confirm} save · ${cancel} back`,
    toggle: `${confirm} toggle · ${cancel} back`,
    report: `↑↓ PgUp/PgDn scroll · ${cancel} back`,
    progress: `Working… · ${cancel} hide`,
    outcome: `${confirm} close · ${cancel} back`,
  };
  return hints[screen.kind];
}
