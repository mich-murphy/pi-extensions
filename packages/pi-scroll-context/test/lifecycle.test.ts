import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { initTheme } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme";
import { testTui, testTheme } from "../../../test-support/pi-tui";
import { createHostAdapter } from "../host";
import scrollContext from "../index";
import type { ScrollRegistration } from "../index";

type Context = Parameters<Parameters<ScrollRegistration["on"]>[1]>[1];
initTheme("dark");

function install(
  factory: Parameters<ExtensionUIContext["setWidget"]>[1],
  tui: ReturnType<typeof testTui>,
): void {
  if (typeof factory === "function") {
    factory(tui, testTheme());
  }
}

const layout = Symbol.for("@earendil-works/pi-tui/layout-node");

describe("extension lifecycle and incompatible hosts", () => {
  test("non-TUI sessions do not install UI; shutdown and repeated start clean up", () => {
    const handlers = new Map<string, (event: unknown, ctx: Context) => void>();
    const api = {
      on: (name: string, handler: (event: unknown, ctx: Context) => void) =>
        handlers.set(name, handler),
    };
    scrollContext(api);
    const widget = vi.fn<ExtensionUIContext["setWidget"]>();
    const ctx = { mode: "rpc", ui: { setWidget: widget, theme: testTheme() } };
    handlers.get("session_start")?.({}, ctx);
    expect(widget).not.toHaveBeenCalled();
    const tui = testTui();
    const request = vi.spyOn(tui, "requestRender").mockImplementation(() => undefined);
    const setWidget = vi.fn<Context["ui"]["setWidget"]>().mockImplementation((_name, factory) => {
      install(factory, tui);
    });
    const interactive = { mode: "tui", ui: { setWidget, theme: testTheme() } };
    handlers.get("session_start")?.({}, interactive);
    handlers.get("session_start")?.({}, interactive);
    handlers.get("session_shutdown")?.({}, interactive);
    handlers.get("session_shutdown")?.({}, interactive);
    expect(setWidget).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(2);
  });

  test.each([
    undefined,
    { render: () => [], [layout]: () => undefined },
    { render: () => [], [layout]: () => ({ type: "scroll" }) },
    { render: () => [], [layout]: () => ({ entries: [null, null] }) },
    {
      render: () => [],
      [layout]: () => {
        throw new Error("incompatible layout");
      },
    },
  ])("leaves incompatible root untouched %#", (root) => {
    const tui = testTui();
    Object.defineProperty(tui, "layoutRoot", { value: root });
    const request = vi.spyOn(tui, "requestRender").mockImplementation(() => undefined);
    const adapter = createHostAdapter(tui, (text) => text);
    expect(adapter.render(30)).toStrictEqual([]);
    expect(request).not.toHaveBeenCalled();
    adapter.dispose();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
