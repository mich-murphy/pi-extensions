import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  SettingsList,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
  Component,
  Focusable,
  KeybindingsManager,
  SettingItem,
  TUI,
} from "@earendil-works/pi-tui";
import { visibleText } from "../../adapter/config.js";
import { hint } from "./model.js";
import type { MenuModel, Screen } from "./model.js";

export type MenuHost = {
  readonly tui: TUI;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly done: () => void;
};
type Entry = {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly description?: string;
};
type TextScreen = Extract<Screen, { kind: "text" }>;

const SETTINGS_LIST_OWN_HINT_ROWS = 2;

export class PeersMenu implements Component, Focusable {
  private hasFocus = false;
  private editor: { readonly screen: Screen; readonly input: Input } | undefined;
  private readonly cursors = new Map<Screen, number>();
  private ended = false;

  constructor(
    private readonly model: MenuModel,
    private readonly host: MenuHost,
  ) {
    model.onRefresh = () => {
      this.update();
    };
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    if (this.editor !== undefined) {
      this.editor.input.focused = value;
    }
  }

  invalidate(): void {
    this.editor?.input.invalidate();
  }

  render(width: number): string[] {
    const { theme } = this.host;
    const screen = this.model.top;
    const border = new DynamicBorder((text) => theme.fg("accent", text)).render(width);
    const note =
      screen.kind === "list" && screen.note !== undefined
        ? new Text(theme.fg("muted", screen.note), 1, 0).render(width)
        : [];
    const keys = { confirm: this.key("tui.select.confirm"), cancel: this.key("tui.select.cancel") };
    return [
      ...border,
      ...new Text(theme.fg("accent", theme.bold(this.model.title())), 1, 0).render(width),
      ...note,
      "",
      ...this.body(screen, width),
      "",
      theme.fg("dim", `  ${hint(screen, this.model.depth, keys)}`),
      ...border,
    ].map((line) => truncateToWidth(line, width));
  }

  handleInput(data: string): void {
    const screen = this.model.top;
    const keys = this.host.keybindings;
    if (keys.matches(data, "tui.select.cancel")) {
      this.model.back();
    } else if (screen.kind === "text") {
      this.edit(screen, data);
    } else if (keys.matches(data, "tui.select.up")) {
      this.move(screen, -1);
    } else if (keys.matches(data, "tui.select.down")) {
      this.move(screen, 1);
    } else if (keys.matches(data, "tui.select.pageUp")) {
      this.page(screen, -1);
    } else if (keys.matches(data, "tui.select.pageDown")) {
      this.page(screen, 1);
    } else if (
      keys.matches(data, "tui.select.confirm") ||
      (data === " " && screen.kind === "list")
    ) {
      this.confirm(screen);
    }
    this.update();
  }

  private update(): void {
    if (!this.model.closed) {
      this.host.tui.requestRender();
    } else if (!this.ended) {
      this.ended = true;
      this.host.done();
    }
  }

  private key(action: "tui.select.confirm" | "tui.select.cancel"): string {
    const binding = this.host.keybindings.getKeys(action)[0];
    if (binding === "enter") {
      return "Enter";
    }
    return binding === "escape" ? "Esc" : (binding ?? "Unbound");
  }

  private maxRows(): number {
    return Math.max(3, Math.min(12, this.host.tui.terminal.rows - 15));
  }

  private entries(screen: Screen): readonly Entry[] {
    if (screen.kind === "list") {
      return screen.rows();
    }
    if (screen.kind === "toggle") {
      return screen
        .items()
        .map((item) => ({ id: item.id, label: item.label, value: item.on ? "On" : "Off" }));
    }
    return [];
  }

  private reportRows(): number {
    return Math.max(3, this.host.tui.terminal.rows - 12);
  }

  private page(screen: Screen, direction: -1 | 1): void {
    const count = this.entries(screen).length;
    if (count > 0) {
      const next = this.cursor(screen, count) + direction * this.maxRows();
      this.cursors.set(screen, Math.max(0, Math.min(count - 1, next)));
    } else {
      const current = this.cursors.get(screen) ?? 0;
      this.cursors.set(screen, Math.max(0, current + direction * this.reportRows()));
    }
  }

  private cursor(screen: Screen, count: number): number {
    return Math.min(Math.max(0, this.cursors.get(screen) ?? 0), Math.max(0, count - 1));
  }

  private move(screen: Screen, delta: number): void {
    const count = this.entries(screen).length;
    const current = this.cursors.get(screen) ?? 0;
    this.cursors.set(
      screen,
      count > 0
        ? (this.cursor(screen, count) + delta + count) % count
        : Math.max(0, current + delta),
    );
  }

  private confirm(screen: Screen): void {
    const entries = this.entries(screen);
    const entry = entries[this.cursor(screen, entries.length)];
    if (screen.kind === "outcome") {
      this.model.close();
    } else if (entry !== undefined && screen.kind === "list") {
      this.model.activate(entry.id);
    } else if (entry !== undefined) {
      this.model.toggle(entry.id);
    }
  }

  private edit(screen: TextScreen, data: string): void {
    const input = this.input(screen);
    if (this.host.keybindings.matches(data, "tui.input.submit")) {
      this.model.submit(input.getValue()).catch(() => undefined);
    } else {
      input.handleInput(data);
    }
  }

  private input(screen: TextScreen): Input {
    if (this.editor?.screen === screen) {
      return this.editor.input;
    }
    const input = new Input();
    input.handleInput(`\u001b[200~${screen.value()}\u001b[201~`);
    input.focused = this.hasFocus;
    this.editor = { screen, input };
    return input;
  }

  private body(screen: Screen, width: number): string[] {
    if (screen.kind === "list" || screen.kind === "toggle") {
      return this.list(screen, width);
    }
    if (screen.kind === "text") {
      const error = this.model.error;
      return [
        ...(screen.description === undefined
          ? []
          : this.wrap([this.host.theme.fg("muted", screen.description)], width)),
        ...this.input(screen).render(width),
        ...(error === undefined ? [] : this.wrap([this.host.theme.fg("error", error)], width)),
      ];
    }
    return this.scroll(screen, screen.lines(), width);
  }

  private list(screen: Screen, width: number): string[] {
    const entries = this.entries(screen);
    const items = entries.map<SettingItem>((entry) => ({
      id: entry.id,
      label: entry.label,
      currentValue: entry.value,
      ...(entry.description === undefined
        ? {}
        : { description: truncateToWidth(entry.description, Math.max(1, width - 6), "…") }),
    }));
    const list = new SettingsList(
      items,
      this.maxRows(),
      getSettingsListTheme(),
      () => undefined,
      () => undefined,
    );
    const selected = entries[this.cursor(screen, entries.length)];
    if (selected !== undefined) {
      list.selectItem(selected.id);
    }
    return list.render(width).slice(0, -SETTINGS_LIST_OWN_HINT_ROWS);
  }

  private wrap(lines: readonly string[], width: number): string[] {
    return lines.flatMap((line) =>
      wrapTextWithAnsi(line, Math.max(10, width - 4)).map((row) => `  ${row}`),
    );
  }

  private scroll(screen: Screen, lines: readonly string[], width: number): string[] {
    const rows = this.wrap(
      lines.map((line) => visibleText(line)),
      width,
    );
    const visible = this.reportRows();
    if (rows.length <= visible) {
      return rows;
    }
    const start = Math.min(this.cursors.get(screen) ?? 0, rows.length - visible);
    this.cursors.set(screen, start);
    return [
      ...rows.slice(start, start + visible),
      this.host.theme.fg("dim", `  (${start + 1}–${start + visible} of ${rows.length})`),
    ];
  }
}
