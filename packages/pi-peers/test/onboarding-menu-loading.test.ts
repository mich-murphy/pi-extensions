import { initTheme } from "@earendil-works/pi-coding-agent";
import { setKeybindings } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { testKeybindings, testTheme, testTui } from "../../../test-support/pi-tui";
import { peersMenu } from "../onboarding/menu/root.js";
import type { RootState } from "../onboarding/menu/root.js";
import { PeersMenu } from "../onboarding/menu/tui.js";
import { NO_CHANGES } from "../onboarding/route.js";

const ENTER = "\r";
const ESCAPE = "\u001b";
const DOWN = "\u001b[B";

const CHECKING: RootState = {
  status: { value: "", lines: ["Checking…"] },
  doctor: ["Checking…"],
  setup: {
    value: "Checking…",
    description: "Reading the saved setup.",
    configured: false,
    cancelled: () => NO_CHANGES,
  },
  resettable: undefined,
  busy: false,
};

const LOADED: RootState = {
  status: { value: "Not set up", lines: ["Peers is not set up"] },
  doctor: ["✗ Config file: not found"],
  setup: {
    value: "Set up",
    description: "Connect this Pi to other sessions.",
    configured: false,
    cancelled: () => NO_CHANGES,
    screen: () => ({ kind: "report", title: "Setup", lines: () => ["Setup form"] }),
  },
  resettable: true,
  busy: false,
};

function loadingMenu() {
  initTheme();
  setKeybindings(testKeybindings());
  let state = CHECKING;

  const model = peersMenu({
    state: () => state,
    reset: async () => ({ ok: true, headline: "✓ Peers turned off", facts: [] }),
    reconnect: async () => ({ ok: true, headline: "✓ Reconnected", facts: [] }),
    started: () => undefined,
    finished: () => undefined,
  });

  const component = new PeersMenu(model, {
    tui: testTui(40),
    theme: testTheme(),
    keybindings: testKeybindings(),
    done: () => undefined,
  });

  const loaded = (start: "setup" | "reset") => {
    state = LOADED;
    model.autoOpen(start);
  };

  const press = (...keys: Array<string>) => {
    for (const key of keys) {
      component.handleInput(key);
    }
  };

  return { model, press, loaded };
}

describe("a command screen opens when loading ends only if no key was pressed", () => {
  test.each([
    ["setup", "Peers › Setup"],
    ["reset", "Peers › Reset"],
  ] as const)("an untouched menu opens %s when loading ends", (start, title) => {
    const menu = loadingMenu();
    menu.loaded(start);
    expect(menu.model.title()).toBe(title);
  });

  test.each([
    ["a cursor move", [DOWN]],
    ["Escape back from a loading Status screen", [ENTER, ESCAPE]],
  ])("%s during loading keeps the root when loading ends", (_name, keys) => {
    const menu = loadingMenu();
    menu.press(...keys);
    menu.loaded("setup");
    expect([menu.model.title(), menu.model.closed]).toStrictEqual(["Peers", false]);
  });

  test("Escape at the loading root closes the menu and loading reopens nothing", () => {
    const menu = loadingMenu();
    menu.press(ESCAPE);
    menu.loaded("setup");
    expect([menu.model.closed, menu.model.depth]).toStrictEqual([true, 0]);
  });
});
