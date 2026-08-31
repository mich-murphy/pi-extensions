import {
  type KeybindingsManager as AppKeybindingsManager,
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type EditorTheme,
  KeybindingsManager,
  setKittyProtocolActive,
  type TUI,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import vimMode from "../index";

const identity = (text: string): string => text;
const theme: EditorTheme = {
  borderColor: identity,
  selectList: {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  },
};

type SessionStartHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: AppKeybindingsManager) => unknown;

function createEditor(): CustomEditor {
  let sessionStart: SessionStartHandler | undefined;
  const piDouble = {
    on(event: string, handler: SessionStartHandler): void {
      if (event === "session_start") sessionStart = handler;
    },
  };
  // SAFETY: Registration calls only ExtensionAPI.on(). The test double captures that handler and invokes it through a concrete TUI context below.
  vimMode(piDouble as unknown as ExtensionAPI);
  if (!sessionStart) throw new Error("Vim extension did not register session_start");

  let editorFactory: EditorFactory | undefined;
  const contextDouble = {
    mode: "tui",
    ui: {
      setEditorComponent(factory: EditorFactory): void {
        editorFactory = factory;
      },
    },
  };
  // SAFETY: The session_start handler reads only ctx.mode and ctx.ui.setEditorComponent. The test double provides both capabilities.
  sessionStart({}, contextDouble as unknown as ExtensionContext);
  if (!editorFactory) throw new Error("Vim extension did not install an editor factory");

  const tuiDouble = {
    terminal: { rows: 40, columns: 120 },
    requestRender: () => undefined,
  };
  // SAFETY: Editor input and rendering use only terminal rows/columns and requestRender. The test double provides those concrete TUI capabilities.
  const tui = tuiDouble as unknown as TUI;
  const tuiKeybindings = new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.interrupt": { defaultKeys: "escape", description: "Interrupt" },
  });
  // SAFETY: These tests exercise editor-level actions only. The TUI manager implements the complete shared keybinding contract; absent app-level bindings correctly resolve as unmatched.
  const keybindings = tuiKeybindings as unknown as AppKeybindingsManager;
  const editor = editorFactory(tui, theme, keybindings);
  if (!(editor instanceof CustomEditor))
    throw new Error("Vim factory returned an unsupported editor");
  return editor;
}

function expectMode(editor: CustomEditor, mode: "INSERT" | "NORMAL"): void {
  expect(editor.render(60).at(-1)?.endsWith(` ${mode} `)).toBe(true);
}

function enterNormalMode(editor: CustomEditor, text: string): void {
  editor.setText(text);
  editor.handleInput("\x1b");
  expectMode(editor, "NORMAL");
}

describe("VimEditor", () => {
  test("does not install an editor outside TUI mode", () => {
    let sessionStart: SessionStartHandler | undefined;
    const piDouble = {
      on(event: string, handler: SessionStartHandler): void {
        if (event === "session_start") sessionStart = handler;
      },
    };
    // SAFETY: Registration calls only ExtensionAPI.on(). The test invokes the captured handler with the mode and UI method it reads.
    vimMode(piDouble as unknown as ExtensionAPI);
    if (!sessionStart) throw new Error("Vim extension did not register session_start");
    let installed = false;
    const contextDouble = {
      mode: "rpc",
      ui: {
        setEditorComponent: () => {
          installed = true;
        },
      },
    };

    // SAFETY: The non-TUI branch reads only ctx.mode and does not call the UI double.
    sessionStart({}, contextDouble as unknown as ExtensionContext);

    expect(installed).toBe(false);
  });

  test("starts in insert mode and inserts ordinary text", () => {
    const editor = createEditor();
    editor.handleInput("h");
    editor.handleInput("i");

    expectMode(editor, "INSERT");
    expect(editor.getText()).toBe("hi");
  });

  test("uses the first escape for Normal mode and the next for Pi interrupt", () => {
    const editor = createEditor();
    let interrupts = 0;
    editor.onEscape = () => {
      interrupts += 1;
    };

    editor.handleInput("\x1b");
    editor.handleInput("\x1b");

    expectMode(editor, "NORMAL");
    expect(interrupts).toBe(1);
  });

  test("supports character, word, and line movement", () => {
    const editor = createEditor();
    enterNormalMode(editor, "one two");

    editor.handleInput("0");
    expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
    editor.handleInput("w");
    expect(editor.getCursor().col).toBe(4);
    editor.handleInput("$");
    expect(editor.getCursor().col).toBe(6);
    editor.handleInput("h");
    expect(editor.getCursor().col).toBe(5);
    editor.handleInput("l");
    editor.handleInput("l");
    expect(editor.getCursor().col).toBe(6);
  });

  test("moves w to the next word across whitespace", () => {
    const editor = createEditor();
    enterNormalMode(editor, "one   two\n  three");

    editor.handleInput("k");
    editor.handleInput("0");
    editor.handleInput("w");
    expect(editor.getCursor()).toEqual({ line: 0, col: 6 });
    editor.handleInput("w");
    expect(editor.getCursor()).toEqual({ line: 1, col: 2 });
  });

  test("supports i, a, A, and I insert commands", () => {
    const cases = [
      { command: "i", expected: "aXb" },
      { command: "a", expected: "abX" },
      { command: "A", expected: "abX" },
      { command: "I", expected: "Xab" },
    ] as const;

    for (const { command, expected } of cases) {
      const editor = createEditor();
      enterNormalMode(editor, "ab");
      editor.handleInput(command);
      editor.handleInput("X");

      expect(editor.getText()).toBe(expected);
      expectMode(editor, "INSERT");
    }
  });

  test("moves vertically and backward by a word", () => {
    const editor = createEditor();
    enterNormalMode(editor, "one two\nthree four");

    editor.handleInput("k");
    expect(editor.getCursor().line).toBe(0);
    editor.handleInput("j");
    expect(editor.getCursor().line).toBe(1);
    editor.handleInput("b");
    expect(editor.getCursor()).toEqual({ line: 1, col: 0 });
  });

  test("supports insert commands and opening lines", () => {
    const below = createEditor();
    enterNormalMode(below, "one");
    below.handleInput("o");
    below.handleInput("t");
    below.handleInput("w");
    below.handleInput("o");
    expect(below.getText()).toBe("one\ntwo");

    const above = createEditor();
    enterNormalMode(above, "two");
    above.handleInput("O");
    above.handleInput("o");
    above.handleInput("n");
    above.handleInput("e");
    expect(above.getText()).toBe("one\ntwo");
  });

  test("ignores movement past the final character", () => {
    const editor = createEditor();
    enterNormalMode(editor, "a");

    editor.handleInput("l");

    expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
  });

  test("handles empty lines, trailing whitespace, and unknown Normal-mode input", () => {
    const empty = createEditor();
    enterNormalMode(empty, "");
    empty.handleInput("l");
    empty.handleInput("q");
    expect(empty.getCursor()).toEqual({ line: 0, col: 0 });

    const trailingWhitespace = createEditor();
    enterNormalMode(trailingWhitespace, "a ");
    trailingWhitespace.handleInput("w");
    expect(trailingWhitespace.getCursor()).toEqual({ line: 0, col: 1 });

    const multiByte = createEditor();
    enterNormalMode(multiByte, "a");
    multiByte.handleInput("unknown-key");
    expectMode(multiByte, "NORMAL");
  });

  test("supports x, D, C, and u through Pi editor actions", () => {
    const undo = createEditor();
    enterNormalMode(undo, "abc");
    undo.handleInput("x");
    expect(undo.getText()).toBe("ab");
    undo.handleInput("u");
    expect(undo.getText()).toBe("abc");

    const deleteToEnd = createEditor();
    enterNormalMode(deleteToEnd, "one two");
    deleteToEnd.handleInput("0");
    deleteToEnd.handleInput("w");
    deleteToEnd.handleInput("D");
    expect(deleteToEnd.getText()).toBe("one ");

    const changeToEnd = createEditor();
    enterNormalMode(changeToEnd, "one two");
    changeToEnd.handleInput("0");
    changeToEnd.handleInput("w");
    changeToEnd.handleInput("C");
    changeToEnd.handleInput("!");
    expectMode(changeToEnd, "INSERT");
    expect(changeToEnd.getText()).toBe("one !");
  });

  test("supports dd and cc without a general operator engine", () => {
    const deletion = createEditor();
    enterNormalMode(deletion, "one\ntwo");
    deletion.handleInput("0");
    deletion.handleInput("k");
    deletion.handleInput("d");
    deletion.handleInput("d");
    expect(deletion.getText()).toBe("two");
    expectMode(deletion, "NORMAL");

    const change = createEditor();
    enterNormalMode(change, "one\ntwo");
    change.handleInput("0");
    change.handleInput("k");
    change.handleInput("c");
    change.handleInput("c");
    change.handleInput("n");
    change.handleInput("e");
    change.handleInput("w");
    expect(change.getText()).toBe("new\ntwo");
    expectMode(change, "INSERT");
  });
});

describe("VimEditor word operations", () => {
  test("supports dw, diw, cw, and ciw with Pi word boundaries", () => {
    const deletion = createEditor();
    enterNormalMode(deletion, "one two");
    deletion.handleInput("0");
    deletion.handleInput("d");
    deletion.handleInput("w");
    expect(deletion.getText()).toBe(" two");

    const deleteInner = createEditor();
    enterNormalMode(deleteInner, "one two");
    deleteInner.handleInput("h");
    deleteInner.handleInput("d");
    deleteInner.handleInput("i");
    deleteInner.handleInput("w");
    expect(deleteInner.getText()).toBe("one ");
    expectMode(deleteInner, "NORMAL");

    const changeForward = createEditor();
    enterNormalMode(changeForward, "one two");
    changeForward.handleInput("0");
    changeForward.handleInput("c");
    changeForward.handleInput("w");
    changeForward.handleInput("red");
    expect(changeForward.getText()).toBe("red two");

    const changeInner = createEditor();
    enterNormalMode(changeInner, "one two");
    changeInner.handleInput("h");
    changeInner.handleInput("c");
    changeInner.handleInput("i");
    changeInner.handleInput("w");
    changeInner.handleInput("red");
    expect(changeInner.getText()).toBe("one red");
  });

  test("supports word edits while the Kitty keyboard protocol is active", () => {
    setKittyProtocolActive(true);
    try {
      const deletion = createEditor();
      enterNormalMode(deletion, "one two");
      deletion.handleInput("0");
      deletion.handleInput("d");
      deletion.handleInput("w");
      expect(deletion.getText()).toBe(" two");

      const deleteInner = createEditor();
      enterNormalMode(deleteInner, "one two");
      deleteInner.handleInput("h");
      deleteInner.handleInput("d");
      deleteInner.handleInput("i");
      deleteInner.handleInput("w");
      expect(deleteInner.getText()).toBe("one ");

      const changeForward = createEditor();
      enterNormalMode(changeForward, "one two");
      changeForward.handleInput("0");
      changeForward.handleInput("c");
      changeForward.handleInput("w");
      changeForward.handleInput("red");
      expect(changeForward.getText()).toBe("red two");

      const changeInner = createEditor();
      enterNormalMode(changeInner, "one two");
      changeInner.handleInput("h");
      changeInner.handleInput("c");
      changeInner.handleInput("i");
      changeInner.handleInput("w");
      changeInner.handleInput("red");
      expect(changeInner.getText()).toBe("one red");
    } finally {
      setKittyProtocolActive(false);
    }
  });

  test("cancels invalid operator sequences without editing", () => {
    const editor = createEditor();
    enterNormalMode(editor, "one.two");

    editor.handleInput("d");
    expect(editor.render(60).at(-1)?.endsWith(" NORMAL d ")).toBe(true);
    editor.handleInput("i");
    expect(editor.render(60).at(-1)?.endsWith(" NORMAL di ")).toBe(true);
    editor.handleInput("q");
    editor.handleInput("c");
    editor.handleInput("i");
    expect(editor.render(60).at(-1)?.endsWith(" NORMAL ci ")).toBe(true);
    editor.handleInput("q");
    editor.handleInput("d");
    editor.handleInput("q");

    expect(editor.getText()).toBe("one.two");
    expectMode(editor, "NORMAL");
  });

  test("treats punctuation as its own inner-word class", () => {
    const editor = createEditor();
    enterNormalMode(editor, "one.two");
    editor.handleInput("h");
    editor.handleInput("h");
    editor.handleInput("h");
    editor.handleInput("d");
    editor.handleInput("i");
    editor.handleInput("w");

    expect(editor.getText()).toBe("onetwo");
  });

  test("cancels pending commands with escape", () => {
    const editor = createEditor();
    enterNormalMode(editor, "one");
    editor.handleInput("d");
    editor.handleInput("\x1b");
    editor.handleInput("w");

    expect(editor.getText()).toBe("one");
    expectMode(editor, "NORMAL");
  });

  test("stays in Normal mode after submitting an empty editor", () => {
    const editor = createEditor();
    enterNormalMode(editor, "");

    editor.handleInput("\r");

    expect(editor.getText()).toBe("");
    expectMode(editor, "NORMAL");
  });

  test("returns to Insert mode after successful submission", () => {
    const editor = createEditor();
    enterNormalMode(editor, "submit me");
    const submissions: string[] = [];
    editor.onSubmit = (text) => {
      submissions.push(text);
      editor.setText("");
    };

    editor.handleInput("\r");

    expect(submissions).toEqual(["submit me"]);
    expectMode(editor, "INSERT");
  });

  test("leaves a border unchanged when it is too narrow for the mode label", () => {
    const editor = createEditor();

    expect(editor.render(1).at(-1)?.endsWith(" INSERT ")).toBe(false);
  });

  test("passes multi-byte unhandled input to Pi", () => {
    const editor = createEditor();
    enterNormalMode(editor, "one\ntwo");

    editor.handleInput("\x1b[B");

    expect(editor.getCursor().line).toBe(1);
  });

  test("renders the mode and pending command in the border", () => {
    const editor = createEditor();
    expect(editor.render(60).at(-1)?.endsWith(" INSERT ")).toBe(true);

    editor.handleInput("\x1b");
    editor.handleInput("c");
    expect(editor.render(60).at(-1)?.endsWith(" NORMAL c ")).toBe(true);
  });
});
