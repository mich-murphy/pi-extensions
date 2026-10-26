import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { getAgentDir, initTheme } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "vitest";
import { testKeybindings, testTheme, testTui } from "../../../test-support/pi-tui";
import { createContextMenu } from "../menu";
import { resourcePathId } from "../resource-path";
import { ResourcePolicy } from "../resources";
import type { ToggleResource, ToggleValue } from "../resources";

const DOWN = "\u001b[B";
const ESCAPE = "\u001b";
const ENTER = "\r";

function resource(
  name: string,
  kind: ToggleResource["kind"],
  origin: ToggleResource["origin"],
  description = "",
): ToggleResource {
  const base = origin === "global" ? getAgentDir() : "/repo";
  const path = kind === "skill" ? join(base, "skills", name, "SKILL.md") : join(base, name);
  return {
    id: resourcePathId(path, base),
    kind,
    origin,
    label: name,
    description,
    editability: "editable",
  };
}

const globalInstruction = resource("AGENTS.md", "instruction", "global", "Personal rules");
const globalSkill = resource("research", "skill", "global", "Research primary sources.");
const projectInstruction = resource("AGENTS.md", "instruction", "project", "Working Agreement");
const projectSkill = resource("deploy", "skill", "project", "Ship carefully.");

function menu(
  resources: readonly ToggleResource[],
  disabled: readonly ToggleResource[] = [],
  keys: KeybindingsManager = testKeybindings(),
) {
  initTheme();
  const files = new Map<ToggleResource["id"], ToggleValue>(disabled.map((r) => [r.id, "disabled"]));
  const writes: (readonly [string, ToggleValue])[] = [];
  let closed = false;
  const component = createContextMenu({
    resources,
    policy: () => new ResourcePolicy({ files, repositories: new Map() }),
    save: (id, value) => {
      const row = resources.find((r) => r.id === id);
      if (row !== undefined) {
        files.set(row.id, value);
        writes.push([id, value]);
      }
    },
    tui: testTui(),
    theme: testTheme(),
    keybindings: keys,
    done: () => {
      closed = true;
    },
  });
  const text = (width = 120) =>
    component
      .render(width)
      .map((line) => stripVTControlCharacters(line))
      .join("\n");
  const press = (...inputs: readonly string[]) => {
    for (const data of inputs) {
      component.handleInput?.(data);
    }
  };
  const open = (index: number) => {
    press(...Array.from({ length: index }, () => DOWN), ENTER);
  };
  return { component, text, press, open, writes, closed: () => closed };
}

describe("context menu", () => {
  afterEach(() => {
    setKeybindings(testKeybindings());
  });
  test("groups resources and explains auto-save only on the main screen", () => {
    const dialog = menu([globalInstruction, globalSkill, projectInstruction, projectSkill]);
    expect(dialog.text()).toContain("Auto-save: each change is saved immediately.");
    expect(dialog.text()).toMatch(/Global instructions\s+Always on/u);
    expect(dialog.text()).toMatch(/Global skills\s+1 on/u);
    expect(dialog.text()).toMatch(/Project skills\s+0 on/u);
    dialog.open(2);
    expect(dialog.text()).toContain("“Working Agreement”");
    expect(dialog.text()).not.toContain("Auto-save");
    expect(dialog.text()).not.toContain("[project instruction]");
  });

  test("global instructions are read-only without reviving previously disabled files", () => {
    const enabled = menu([globalInstruction]);
    enabled.open(0);
    enabled.press(ENTER, " ");
    expect(enabled.text()).toMatch(/AGENTS.md\s+Always on/u);
    expect(enabled.writes).toStrictEqual([]);
    const disabled = menu([globalInstruction], [globalInstruction]);
    expect(disabled.text()).toMatch(/Global instructions\s+1 off/u);
    expect(disabled.writes).toStrictEqual([]);
    disabled.open(0);
    expect(disabled.text()).toMatch(/AGENTS.md\s+Off/u);
    disabled.press(ENTER, ENTER);
    expect(disabled.writes).toStrictEqual([[globalInstruction.id, "enabled"]]);
    expect(disabled.text()).toMatch(/AGENTS.md\s+Always on/u);
    disabled.press(ESCAPE);
    expect(disabled.text()).toMatch(/Global instructions\s+Always on/u);
  });

  test("quotes actual skill descriptions inline and keeps source text secondary", () => {
    const dialog = menu([globalSkill]);
    dialog.open(1);
    const row = dialog
      .text()
      .split("\n")
      .find((line) => line.includes("research"));
    expect(row).toMatch(/research\s+On\s+“Research primary sources\.”/u);
    expect(dialog.text().split("Research primary sources.")).toHaveLength(2);
    const styled = dialog.component
      .render(120)
      .find((line) => line.includes("Research primary sources."));
    expect(styled).toContain(testTheme().fg("muted", "“Research primary sources.”"));
  });

  test("manual-only rows stay readable and cannot be toggled", () => {
    const manual = { ...projectSkill, editability: "manual-only" as const };
    const dialog = menu([manual]);
    dialog.open(3);
    dialog.press(ENTER, " ");
    expect(dialog.text()).toMatch(/deploy\s+Manual only\s+“Ship carefully\.”/u);
    expect(dialog.writes).toStrictEqual([]);
  });

  test("search clears before back, saves immediately and updates the parent count", () => {
    const dialog = menu([globalSkill]);
    dialog.open(1);
    dialog.press("research");
    expect(dialog.text()).toContain("Esc clear");
    dialog.press(ENTER);
    expect(dialog.writes).toStrictEqual([[globalSkill.id, "disabled"]]);
    expect(dialog.text()).toMatch(/research\s+Off/u);
    dialog.press(ESCAPE);
    expect(dialog.text()).toContain("Esc back");
    expect(dialog.closed()).toBe(false);
    dialog.press(ESCAPE);
    expect(dialog.text()).toMatch(/Global skills\s+0 on/u);
    dialog.press(ESCAPE);
    expect(dialog.closed()).toBe(true);
  });

  test("handles no matches, search spaces, paging and selection across a resize", () => {
    const resources = Array.from({ length: 30 }, (_, i) =>
      resource(`skill-${String(i).padStart(2, "0")}`, "skill", "global"),
    );
    const dialog = menu(resources);
    dialog.open(1);
    dialog.press("\u001b[6~");
    expect(dialog.text()).toContain("(17/30)");
    dialog.press("\u001b[5~", DOWN);
    expect(dialog.text(60)).toMatch(/→ skill-01\s+On/u);
    dialog.press("zzz", " ");
    expect(dialog.text()).toContain("No matches");
    expect(dialog.text()).toContain("> zzz ");
    dialog.press(ESCAPE);
    expect(dialog.text()).not.toContain("No matches");
  });

  test("keeps states and quoted Unicode excerpts visible at 60 columns", () => {
    const skill = resource(
      "界".repeat(10),
      "skill",
      "global",
      "\u001b[31mExact source wording across a long description with 界 and accents é.\u001b[0m",
    );
    const dialog = menu([skill]);
    dialog.open(1);
    const text = dialog.text(60);
    expect(text).toContain("On");
    expect(text).toMatch(/“Exact source.*…”/u);
    for (const width of [1, 8, 20, 40, 60, 120]) {
      expect(dialog.component.render(width).every((line) => visibleWidth(line) <= width)).toBe(
        true,
      );
    }
  });

  test("gives a long skill name and state priority over its description", () => {
    const name = "a-long-skill-name-that-still-fits-at-sixty";
    const skill = resource(
      name,
      "skill",
      "global",
      "This is source metadata, not part of the name.",
    );
    const dialog = menu([skill]);
    dialog.open(1);
    expect(dialog.text(60)).toContain(name);
    expect(dialog.text(60)).toContain("On");
    expect(dialog.text(60)).not.toContain("This is source metadata");
    expect(dialog.text(120)).toContain("“This is source metadata, not part of the name.”");
  });

  test("propagates search focus and shows configured action keys", () => {
    const keys = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.confirm": ["ctrl+y"],
      "tui.select.cancel": ["ctrl+x"],
    });
    setKeybindings(keys);
    const dialog = menu([globalSkill], [], keys);
    expect(dialog.text()).toContain("ctrl+y open · ctrl+x close");
    dialog.component.focused = true;
    dialog.press(DOWN, "\u0019");
    expect(dialog.component.focused).toBe(true);
    expect(dialog.text()).toContain("ctrl+y toggle · ctrl+x back");
    dialog.component.focused = false;
    expect(dialog.component.focused).toBe(false);
  });
});
