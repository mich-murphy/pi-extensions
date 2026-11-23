export type Consent = { consented: (action: string) => void };

export type ActGuard = { readonly canAct: () => boolean; readonly busy: string };

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
  error: string | undefined;
  acted = false;
  busy = false;
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
        this.error = row.description;
        break;
      }
    }
  }

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
