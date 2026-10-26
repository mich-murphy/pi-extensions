import { stripVTControlCharacters } from "node:util";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  fuzzyFilter,
  Input,
  SelectList,
  SettingsList,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type {
  Component,
  Focusable,
  KeybindingsManager,
  SelectItem,
  SettingItem,
  TUI,
} from "@earendil-works/pi-tui";
import type { ResourcePolicy, ToggleResource, ToggleValue } from "./resources";

export type MenuOptions = {
  readonly resources: readonly ToggleResource[];
  readonly policy: () => ResourcePolicy;
  readonly save: (id: string, value: ToggleValue) => void;
  readonly tui: TUI;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly done: () => void;
};

type Group = Pick<ToggleResource, "origin" | "kind"> & { readonly title: string };

const GROUPS: readonly Group[] = [
  { title: "Global instructions", origin: "global", kind: "instruction" },
  { title: "Global skills", origin: "global", kind: "skill" },
  { title: "Project instructions", origin: "project", kind: "instruction" },
  { title: "Project skills", origin: "project", kind: "skill" },
];

export function createContextMenu(options: MenuOptions): Component & Focusable {
  return new ContextMenu(options);
}

class ContextMenu implements Component, Focusable {
  private readonly root: SettingsList;
  private active: ResourceList | undefined;
  private hasFocus = false;

  constructor(private readonly options: MenuOptions) {
    const items = GROUPS.map<SettingItem>((group) => {
      const resources = options.resources.filter(
        (r) => r.origin === group.origin && r.kind === group.kind,
      );
      return {
        id: group.title,
        label: group.title,
        currentValue: this.count(group, resources),
        ...(resources.length === 0
          ? {}
          : {
              submenu: (_value: string, back: (value?: string) => void) => {
                this.active = new ResourceList(options, group, resources, () => {
                  this.active = undefined;
                  back(this.count(group, resources));
                });
                this.active.focused = this.hasFocus;
                return this.active;
              },
            }),
      };
    });
    this.root = new SettingsList(
      items,
      6,
      {
        ...getSettingsListTheme(),
        hint: () =>
          options.theme.fg(
            "dim",
            `  ${key(options, "tui.select.confirm")} open · ${key(options, "tui.select.cancel")} close`,
          ),
      },
      () => undefined,
      options.done,
    );
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    if (this.active !== undefined) {
      this.active.focused = value;
    }
  }

  render(width: number): string[] {
    const { theme } = this.options;
    const border = new DynamicBorder((text) => theme.fg("accent", text));
    const title = this.active?.title() ?? "Context";
    const heading = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
    const note =
      this.active === undefined
        ? new Text(theme.fg("muted", "Auto-save: each change is saved immediately."), 1, 0).render(
            width,
          )
        : [];
    return [
      ...border.render(width),
      ...heading.render(width),
      ...note,
      "",
      ...this.root.render(Math.max(10, width)),
      ...border.render(width),
    ].map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {
    this.root.invalidate();
  }

  handleInput(data: string): void {
    this.root.handleInput(data);
    this.invalidate();
    this.options.tui.requestRender();
  }

  private count(group: Group, resources: readonly ToggleResource[]): string {
    const policy = this.options.policy();
    const enabled = resources.filter((r) => policy.value(r) === "enabled").length;
    if (group.origin === "global" && group.kind === "instruction") {
      if (resources.length === 0) {
        return "Not loaded";
      }
      return enabled === resources.length ? "Always on" : `${resources.length - enabled} off`;
    }
    return `${enabled} on`;
  }
}

class ResourceList implements Component, Focusable {
  private readonly search = new Input();
  private list: SelectList;
  private selected: string | undefined;
  private width = 80;

  constructor(
    private readonly options: MenuOptions,
    private readonly group: Group,
    private readonly resources: readonly ToggleResource[],
    private readonly back: () => void,
  ) {
    this.list = this.createList();
  }

  get focused(): boolean {
    return this.search.focused;
  }

  set focused(value: boolean) {
    this.search.focused = value;
  }

  title(): string {
    if (this.group.origin === "global") {
      return this.group.title;
    }
    const repositoryResources = this.resources.filter((r) =>
      this.options.policy().repositoryWide(r),
    ).length;
    if (repositoryResources === this.resources.length) {
      return `${this.group.title} · all worktrees`;
    }
    return `${this.group.title} · ${repositoryResources === 0 ? "per path" : "mixed scope"}`;
  }

  render(width: number): string[] {
    this.width = width;
    this.list = this.createList();
    const { theme } = this.options;
    const cancel = this.search.getValue() === "" ? "back" : "clear";
    const hint = `${key(this.options, "tui.select.confirm")} toggle · ${key(this.options, "tui.select.cancel")} ${cancel}`;
    const prefix = this.search.getValue() === "" ? "Type to search · " : "";
    return [
      ...this.search.render(width),
      "",
      ...this.list.render(Math.max(10, width)),
      "",
      theme.fg("dim", `  ${prefix}${hint}`),
    ];
  }

  invalidate(): void {
    this.search.invalidate();
    this.list.invalidate();
  }

  handleInput(data: string): void {
    const keys = this.options.keybindings;
    if (keys.matches(data, "tui.select.cancel")) {
      if (this.search.getValue() === "") {
        this.back();
      } else {
        this.search.setValue("");
        this.rebuild();
      }
    } else if (
      keys.matches(data, "tui.select.confirm") ||
      (data === " " && this.search.getValue() === "")
    ) {
      this.toggle();
    } else if (!this.navigate(data)) {
      this.search.handleInput(data);
      this.rebuild();
    }
  }

  private navigate(data: string): boolean {
    const keys = this.options.keybindings;
    if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
      this.list.handleInput(data);
      return true;
    }
    if (keys.matches(data, "tui.select.pageUp") || keys.matches(data, "tui.select.pageDown")) {
      const direction = keys.matches(data, "tui.select.pageUp") ? -1 : 1;
      const index = this.filtered().findIndex((r) => r.id === this.list.getSelectedItem()?.value);
      this.list.setSelectedIndex(index + direction * this.maxRows());
      this.selected = this.list.getSelectedItem()?.value;
      return true;
    }
    return false;
  }

  private rebuild(): void {
    this.selected = undefined;
    this.list = this.createList();
  }

  private filtered(): readonly ToggleResource[] {
    return fuzzyFilter([...this.resources], this.search.getValue(), (r) => r.label);
  }

  private maxRows(): number {
    return Math.max(3, Math.min(16, this.options.tui.terminal.rows - 10));
  }

  private createList(): SelectList {
    const resources = this.filtered();
    const states = new Map<string, string>(resources.map((r) => [r.id, this.value(r)]));
    const stateWidth = Math.max(3, ...[...states.values()].map((value) => visibleWidth(value)));
    const nameWidth = Math.max(
      1,
      Math.min(
        Math.max(1, ...this.resources.map((r) => visibleWidth(r.label))),
        this.width - stateWidth - 6,
      ),
    );
    const primaryWidth = nameWidth + stateWidth + 4;
    const descriptionWidth = this.width - primaryWidth - 4;
    const { theme } = this.options;
    const items = resources.map<SelectItem>((r) => {
      const quotation = sourceQuote(r.description, descriptionWidth);
      return {
        value: r.id,
        label: r.label,
        description: quotation === "" ? "" : theme.fg("muted", quotation),
      };
    });
    const list = new SelectList(
      items,
      this.maxRows(),
      {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => text,
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: () => theme.fg("muted", "  No matches"),
      },
      {
        minPrimaryColumnWidth: primaryWidth,
        maxPrimaryColumnWidth: primaryWidth,
        truncatePrimary: ({ item, maxWidth, isSelected }) => {
          const state = states.get(item.value) ?? "Off";
          const available = Math.max(0, maxWidth - stateWidth - 2);
          const name = truncateToWidth(item.label, available, "…");
          const padding = " ".repeat(Math.max(0, available - visibleWidth(name)));
          const style = getSettingsListTheme();
          return `${style.label(name + padding, isSelected)}  ${style.value(state.padEnd(stateWidth), isSelected)}`;
        },
      },
    );
    const index = resources.findIndex((r) => r.id === this.selected);
    list.setSelectedIndex(Math.max(0, index));
    list.onSelectionChange = (item) => {
      this.selected = item.value;
    };
    return list;
  }

  private value(resource: ToggleResource): string {
    if (resource.editability === "manual-only") {
      return "Manual only";
    }
    if (this.fixed(resource)) {
      return "Always on";
    }
    return this.options.policy().value(resource) === "enabled" ? "On" : "Off";
  }

  private fixed(resource: ToggleResource): boolean {
    return (
      resource.kind === "instruction" &&
      resource.origin === "global" &&
      this.options.policy().value(resource) === "enabled"
    );
  }

  private toggle(): void {
    const resource = this.resources.find((r) => r.id === this.list.getSelectedItem()?.value);
    if (resource === undefined || resource.editability === "manual-only" || this.fixed(resource)) {
      return;
    }
    this.selected = resource.id;
    const value = this.options.policy().value(resource) === "enabled" ? "disabled" : "enabled";
    this.options.save(resource.id, value);
    this.list = this.createList();
  }
}

function sourceQuote(source: string, width: number): string {
  const text = stripVTControlCharacters(source).replaceAll(/\s+/gu, " ").trim();
  return text === "" || width < 3 ? "" : `“${truncateToWidth(text, width - 2, "…")}”`;
}

function key(options: MenuOptions, action: "tui.select.confirm" | "tui.select.cancel"): string {
  const binding = options.keybindings.getKeys(action)[0];
  if (binding === "enter") {
    return "Enter";
  }
  return binding === "escape" ? "Esc" : (binding ?? "Unbound");
}
