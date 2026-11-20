import type { MockInstance } from "vitest";
import { describe, expect, test, vi } from "vitest";
import { initTheme } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme";
import { testTheme, testTui } from "../../../test-support/pi-tui";
import scrollback from "../index";
import type { ScrollRegistration } from "../index";

type Command = Parameters<ScrollRegistration["registerCommand"]>[1];
type Handler = Parameters<ScrollRegistration["on"]>[1];
type CommandContext = Parameters<Command["handler"]>[1];

initTheme("dark");

/** Each installed adapter gets its own TUI; its dispose is the only thing that requests a render. */
type Installed = { renders: MockInstance<() => void> };

function setup(mode = "tui") {
  const adapters: Installed[] = [];
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  scrollback({
    on: (name, handler) => {
      handlers.set(name, handler);
    },
    registerCommand: (name, options) => {
      commands.set(name, options);
    },
  });
  const setWidget = vi.fn<CommandContext["ui"]["setWidget"]>((_key, content) => {
    if (typeof content === "function") {
      const tui = testTui();
      const renders = vi.spyOn(tui, "requestRender").mockImplementation(() => undefined);
      content(tui, testTheme());
      adapters.push({ renders });
    }
  });
  const notify = vi.fn<CommandContext["ui"]["notify"]>();
  const ctx: CommandContext = { mode, ui: { setWidget, notify, theme: testTheme() } };
  const command = commands.get("scrollback");
  if (command === undefined) {
    throw new Error("/scrollback is not registered");
  }
  return {
    adapters,
    ctx,
    setWidget,
    notify,
    command,
    start: () => handlers.get("session_start")?.({}, ctx),
    run: async (args: string) => command.handler(args, ctx),
  };
}

describe("/scrollback [on|off]", () => {
  test("is on by default and installs the widget under the scrollback key", () => {
    const { adapters, start, setWidget } = setup();
    start();
    expect(setWidget).toHaveBeenCalledTimes(1);
    expect(setWidget.mock.calls[0]?.[0]).toBe("scrollback");
    expect(adapters).toHaveLength(1);
  });

  test("no argument toggles: off disposes and clears, on installs again", async () => {
    const { adapters, start, run, setWidget, notify } = setup();
    start();
    await run("");
    expect(adapters[0]?.renders).toHaveBeenCalledTimes(1);
    expect(setWidget).toHaveBeenLastCalledWith("scrollback", undefined);
    expect(notify).toHaveBeenLastCalledWith("Scrollback is off for this session.", "info");
    await run("  ");
    expect(adapters).toHaveLength(2);
    expect(setWidget.mock.calls.at(-1)?.[0]).toBe("scrollback");
    expect(typeof setWidget.mock.calls.at(-1)?.[1]).toBe("function");
    expect(notify).toHaveBeenLastCalledWith("Scrollback is on for this session.", "info");
  });

  test("explicit on while on and off while off do not reinstall or dispose again", async () => {
    const { adapters, start, run, setWidget, notify } = setup();
    start();
    await run("on");
    expect(adapters).toHaveLength(1);
    expect(adapters[0]?.renders).not.toHaveBeenCalled();
    expect(setWidget).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith("Scrollback is on for this session.", "info");
    await run("off");
    await run("off");
    expect(adapters[0]?.renders).toHaveBeenCalledTimes(1);
    expect(setWidget).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith("Scrollback is off for this session.", "info");
  });

  test("session_start while off installs nothing until turned on", async () => {
    const { adapters, start, run, setWidget } = setup();
    await run("off");
    start();
    expect(adapters).toHaveLength(0);
    expect(setWidget).toHaveBeenCalledTimes(1);
    await run("on");
    expect(adapters).toHaveLength(1);
    start();
    expect(adapters[0]?.renders).toHaveBeenCalledTimes(1);
    expect(adapters).toHaveLength(2);
  });

  test("an invalid argument warns with usage and keeps the state", async () => {
    const { adapters, start, run, notify } = setup();
    start();
    await run("maybe");
    expect(notify).toHaveBeenCalledExactlyOnceWith("Usage: /scrollback [on|off]", "warning");
    expect(adapters[0]?.renders).not.toHaveBeenCalled();
    await run("");
    expect(notify).toHaveBeenLastCalledWith("Scrollback is off for this session.", "info");
  });
});
