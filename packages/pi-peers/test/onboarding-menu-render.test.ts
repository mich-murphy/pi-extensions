import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { testKeybindings, testTheme, testTui } from "../../../test-support/pi-tui";
import type { MenuModel, Screen } from "../onboarding/menu/model.js";
import { remoteDraft } from "../onboarding/menu/remote-form.js";
import { peersMenu } from "../onboarding/menu/root.js";
import { setupForm } from "../onboarding/menu/setup-form.js";
import { PeersMenu } from "../onboarding/menu/tui.js";
import { defaultChoices } from "../onboarding/plan.js";
import { NO_CHANGES, SETUP_STEPS } from "../onboarding/route.js";

const ENTER = "\r";
const ESCAPE = "\u001b";
const DOWN = "\u001b[B";
const HINT = /^(?<keys>.+) · Esc (?<esc>back|close|hide)$/u;

type MenuHolder = { model?: MenuModel };

function menu(rows: number, start?: "setup" | "reset") {
  initTheme();
  setKeybindings(testKeybindings());
  let closed = false;
  const draft = {
    mode: "local" as const,
    choices: defaultChoices("Render Host"),
    socket: "/private/owned/s",
    socketRequired: false,
    shared: false,
    remote: remoteDraft(),
  };
  const holder: MenuHolder = {};
  const model = peersMenu(
    {
      state: () => ({
        status: { value: "Not set up", lines: ["Peers is not set up", "Next: choose Setup"] },
        doctor: ["✗ Config file: not found", "Next: choose Setup"],
        setup: {
          value: "Set up",
          description: "Connect this Pi to other sessions. Nothing changes until Apply.",
          configured: false,
          cancelled: () => NO_CHANGES,
          screen: (progress) =>
            setupForm({
              draft,
              details: () => Array.from({ length: 40 }, (_, i) => `Detail ${i}`).join("\n"),
              apply: () => {
                progress("Applying", SETUP_STEPS, async () => ({
                  ok: true,
                  headline: "✓ Peers set up — connected as render-host",
                  facts: [],
                  next: "Open another Pi session to collaborate.",
                }));
              },
            }),
        },
        resettable: false,
        busy: false,
      }),
      reset: async () => ({ ok: true, headline: "✓ Peers turned off", facts: [] }),
      reconnect: async () => ({ ok: true, headline: "✓ Reconnected", facts: [] }),
      started: () => undefined,
      finished: () => undefined,
    },
    undefined,
    start,
  );
  holder.model = model;
  const component = new PeersMenu(model, {
    tui: testTui(rows),
    theme: testTheme(),
    keybindings: testKeybindings(),
    done: () => {
      closed = true;
    },
  });
  const press = (...keys: string[]) => {
    for (const key of keys) {
      component.handleInput(key);
    }
  };
  return { model, component, press, closed: () => closed };
}

async function settled(screen: Screen): Promise<void> {
  if (screen.kind === "progress") {
    await screen.done;
  }
}

function contract(lines: readonly string[], width: number, cursors: number) {
  const text = lines.map((line) => stripVTControlCharacters(line).trim());
  expect(text[0]).toMatch(/^─+$/u);
  expect(text.at(-1)).toMatch(/^─+$/u);
  expect(text[1]).toMatch(/^Peers(?: › [^›]+)*$/u);
  expect(text.at(-2)).toMatch(HINT);
  expect(text.filter((line) => line.startsWith("→ "))).toHaveLength(cursors);
  expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  return text;
}

describe.each([
  [80, 20],
  [140, 50],
])("peers menu screen contract at %ix%i", (width, rows) => {
  const budget = rows - 5;
  test("root, setup form, editor, permissions, details and back navigation", () => {
    const view = menu(rows);
    let text = contract(view.component.render(width), width, 1);
    expect(text[1]).toBe("Peers");
    expect(text.at(-2)).toBe("Enter select · Esc close");
    view.press(DOWN, ENTER);
    text = contract(view.component.render(width), width, 1);
    expect(text[1]).toBe("Peers › Setup");
    expect(text).toContain("Nothing changes until you choose Apply.");
    expect(view.component.render(width).length).toBeLessThanOrEqual(budget);
    view.press(DOWN, ENTER);
    text = contract(view.component.render(width), width, 0);
    expect([text[1], text.at(-2)]).toStrictEqual([
      "Peers › Setup › Machine",
      "Enter save · Esc back",
    ]);
    view.press("!");
    expect(contract(view.component.render(width), width, 0).join("\n")).toContain("render-host!");
    view.press(ENTER);
    expect(contract(view.component.render(width), width, 0).join("\n")).toContain("lowercase");
    view.press(ESCAPE, DOWN, DOWN, DOWN, ENTER);
    text = contract(view.component.render(width), width, 1);
    expect([text[1], text.at(-2)]).toStrictEqual([
      "Peers › Setup › Permissions",
      "Enter toggle · Esc back",
    ]);
    view.press(ESCAPE, DOWN, ENTER);
    text = contract(view.component.render(width), width, 0);
    expect([text[1], text.at(-2)]).toStrictEqual([
      "Peers › Setup › Details",
      "↑↓ PgUp/PgDn scroll · Esc back",
    ]);
    expect(view.component.render(width).length).toBeLessThanOrEqual(budget);
    view.press(ESCAPE, ESCAPE, ESCAPE);
    expect(view.closed()).toBe(true);
  });
  test("apply shows progress, then the outcome", async () => {
    const view = menu(rows, "setup");
    view.press(...Array.from({ length: 6 }, () => DOWN), ENTER);
    let text = contract(view.component.render(width), width, 0);
    expect([text[1], text.at(-2)]).toStrictEqual([
      "Peers › Setup › Applying",
      "Working… · Esc hide",
    ]);
    await settled(view.model.top);
    text = contract(view.component.render(width), width, 0);
    expect(text[1]).toBe("Peers › Setup › Result");
    expect(text[3]).toBe("✓ Peers set up — connected as render-host");
    expect(text.at(-2)).toBe("Enter close · Esc back");
    view.press(ESCAPE);
    expect(contract(view.component.render(width), width, 1)[1]).toBe("Peers");
  });
});
