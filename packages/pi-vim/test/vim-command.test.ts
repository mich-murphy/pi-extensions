import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { testKeybindings, testTui } from "../../../test-support/pi-tui";
import { loadVim, theme } from "./vim-harness";
import type { EditorFactory } from "./vim-harness";

function expectVimEditor(factory: EditorFactory | undefined): void {
  expect(factory).toBeDefined();
  const editor = factory?.(testTui(), theme, testKeybindings());
  expect(editor).toBeInstanceOf(CustomEditor);
  expect(editor?.render(60).at(-1)?.endsWith(" INSERT ")).toBe(true);
}

describe("/vim", () => {
  test("completes on and off", () => {
    const { command } = loadVim("tui");

    expect(command.getArgumentCompletions("")).toStrictEqual([
      { value: "on", label: "on" },
      { value: "off", label: "off" },
    ]);
    expect(command.getArgumentCompletions("of")).toStrictEqual([{ value: "off", label: "off" }]);
    expect(command.getArgumentCompletions("x")).toStrictEqual([]);
  });

  test("toggles off then on with no argument", async () => {
    const session = loadVim("tui");
    session.startSession();

    await session.runCommand("");
    expect(session.editors.at(-1)).toBeUndefined();
    expect(session.notices.at(-1)).toStrictEqual({
      message: "Vim is off for this session.",
      type: "info",
    });

    await session.runCommand("  ");
    expectVimEditor(session.editors.at(-1));
    expect(session.notices.at(-1)).toStrictEqual({
      message: "Vim is on for this session.",
      type: "info",
    });
    expect(session.editors).toHaveLength(3);
  });

  test("sets an explicit state, repeating it without toggling", async () => {
    const session = loadVim("tui");

    await session.runCommand("off");
    await session.runCommand("off");
    expect(session.editors).toStrictEqual([undefined, undefined]);
    expect(session.notices.map((notice) => notice.message)).toStrictEqual([
      "Vim is off for this session.",
      "Vim is off for this session.",
    ]);

    await session.runCommand(" on ");
    await session.runCommand("on");
    expect(session.editors).toHaveLength(4);
    expectVimEditor(session.editors[2]);
    expectVimEditor(session.editors[3]);
    expect(session.notices.at(-1)?.message).toBe("Vim is on for this session.");
  });

  test("warns about an invalid argument and keeps the current state", async () => {
    const session = loadVim("tui");

    await session.runCommand("maybe");

    expect(session.notices).toStrictEqual([{ message: "Usage: /vim [on|off]", type: "warning" }]);
    expect(session.editors).toStrictEqual([]);
    session.startSession();
    expectVimEditor(session.editors.at(-1));
  });

  test("keeps Pi's editor at session start while off", async () => {
    const session = loadVim("tui");
    await session.runCommand("off");

    session.startSession();

    expect(session.editors).toStrictEqual([undefined]);
  });

  test("installs Vim again at session start after turning it back on", async () => {
    const session = loadVim("tui");
    await session.runCommand("off");
    await session.runCommand("on");

    session.startSession();

    expect(session.editors).toHaveLength(3);
    expectVimEditor(session.editors.at(-1));
  });

  test("changes no editor outside TUI mode but still records the state", async () => {
    const session = loadVim("rpc");

    await session.runCommand("off");
    expect(session.editors).toStrictEqual([]);
    expect(session.notices.at(-1)?.message).toBe("Vim is off for this session.");

    session.startSession();
    expect(session.editors).toStrictEqual([]);
  });
});
