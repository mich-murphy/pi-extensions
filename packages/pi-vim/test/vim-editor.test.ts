import {
  type KeybindingsManager as AppKeybindingsManager,
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteProvider,
  type EditorTheme,
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  setKittyProtocolActive,
  type TUI,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
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

/** Start a session in the given Pi mode and return the editor factory the extension installed. */
function installedEditorFactory(mode: ExtensionContext["mode"]): EditorFactory | undefined {
  let sessionStart: SessionStartHandler | undefined;
  const piDouble = {
    on(event: string, handler: SessionStartHandler): void {
      if (event === "session_start") sessionStart = handler;
    },
  };
  // SAFETY: Registration calls only ExtensionAPI.on(). The double captures that handler.
  vimMode(piDouble as unknown as ExtensionAPI);
  if (!sessionStart) throw new Error("Vim extension did not register session_start");

  let editorFactory: EditorFactory | undefined;
  const contextDouble = {
    mode,
    ui: {
      setEditorComponent(factory: EditorFactory): void {
        editorFactory = factory;
      },
    },
  };
  // SAFETY: The session_start handler reads only ctx.mode and ctx.ui.setEditorComponent.
  sessionStart({}, contextDouble as unknown as ExtensionContext);
  return editorFactory;
}

function createEditor(): CustomEditor {
  const editorFactory = installedEditorFactory("tui");
  if (!editorFactory) throw new Error("Vim extension did not install an editor factory");

  const tuiDouble = {
    terminal: { rows: 40, columns: 120 },
    requestRender: () => undefined,
  };
  const tuiKeybindings = new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.interrupt": { defaultKeys: "escape", description: "Interrupt" },
  });
  const editor = editorFactory(
    // SAFETY: Editor input and rendering use only terminal rows/columns and requestRender.
    tuiDouble as unknown as TUI,
    theme,
    // SAFETY: The TUI manager implements the complete shared keybinding contract. Absent app-level bindings resolve as unmatched.
    tuiKeybindings as unknown as AppKeybindingsManager,
  );
  if (!(editor instanceof CustomEditor))
    throw new Error("Vim factory returned an unsupported editor");
  return editor;
}

/** How a terminal encodes key presses. Pi negotiates one of these per session. */
type Keyboard = {
  readonly name: string;
  readonly kittyProtocol: boolean;
  readonly escape: string;
  readonly press: (key: string) => string;
};

const SHIFTED_SYMBOL_BASE_KEYS: ReadonlyMap<string, string> = new Map([["$", "4"]]);

/** Kitty reports every key as CSI-u, with the shifted character as an alternate key. */
function kittyPress(key: string): string {
  const base = SHIFTED_SYMBOL_BASE_KEYS.get(key) ?? key.toLowerCase();
  const code = key.codePointAt(0);
  return base === key ? `\x1b[${code}u` : `\x1b[${base.codePointAt(0)}:${code};2u`;
}

const KEYBOARDS: ReadonlyArray<Keyboard> = [
  { name: "legacy", kittyProtocol: false, escape: "\x1b", press: identity },
  { name: "Kitty", kittyProtocol: true, escape: "\x1b[27u", press: kittyPress },
];

function expectLabel(editor: CustomEditor, label: string): void {
  expect(editor.render(60).at(-1)?.endsWith(` ${label} `)).toBe(true);
}

afterEach(() => {
  setKittyProtocolActive(false);
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});

describe.each(KEYBOARDS)("VimEditor with a $name keyboard", (keyboard) => {
  function typeKeys(editor: CustomEditor, keys: string): void {
    for (const key of keys) editor.handleInput(keyboard.press(key));
  }

  /** An editor holding `text`, switched to Normal mode, after typing `keys`. */
  function normalMode(text: string, keys = ""): CustomEditor {
    setKittyProtocolActive(keyboard.kittyProtocol);
    const editor = createEditor();
    editor.setText(text);
    editor.handleInput(keyboard.escape);
    typeKeys(editor, keys);
    return editor;
  }

  test("starts in Insert mode and inserts ordinary text", () => {
    setKittyProtocolActive(keyboard.kittyProtocol);
    const editor = createEditor();
    typeKeys(editor, "hi");

    expectLabel(editor, "INSERT");
    expect(editor.getText()).toBe("hi");
  });

  test("uses the first escape for Normal mode and the next for Pi interrupt", () => {
    setKittyProtocolActive(keyboard.kittyProtocol);
    const editor = createEditor();
    let interrupts = 0;
    editor.onEscape = () => {
      interrupts += 1;
    };

    editor.handleInput(keyboard.escape);
    expectLabel(editor, "NORMAL");
    expect(interrupts).toBe(0);

    editor.handleInput(keyboard.escape);
    expectLabel(editor, "NORMAL");
    expect(interrupts).toBe(1);
  });

  test("steps back onto the last typed character when leaving Insert mode", () => {
    const editor = normalMode("ab", "aX");
    editor.handleInput(keyboard.escape);

    expect(editor.getText()).toBe("abX");
    expect(editor.getCursor()).toEqual({ line: 0, col: 2 });
  });

  test.each([
    { text: "one two", keys: "0", cursor: { line: 0, col: 0 } },
    { text: "one two", keys: "0w", cursor: { line: 0, col: 4 } },
    { text: "one two", keys: "$", cursor: { line: 0, col: 6 } },
    { text: "one two", keys: "$h", cursor: { line: 0, col: 5 } },
    { text: "one two", keys: "$hll", cursor: { line: 0, col: 6 } },
    { text: "one two", keys: "b", cursor: { line: 0, col: 4 } },
    { text: "one two\nthree four", keys: "k", cursor: { line: 0, col: 6 } },
    { text: "one two\nthree four", keys: "kj0", cursor: { line: 1, col: 0 } },
    { text: "one   two\n  three", keys: "k0w", cursor: { line: 0, col: 6 } },
    { text: "one   two\n  three", keys: "k0ww", cursor: { line: 1, col: 2 } },
    { text: "one.two", keys: "0w", cursor: { line: 0, col: 3 } },
    { text: "a ", keys: "0w", cursor: { line: 0, col: 1 } },
    { text: "a😀b", keys: "0ll", cursor: { line: 0, col: 3 } },
    { text: "", keys: "hlwb0$", cursor: { line: 0, col: 0 } },
  ])("moves with $keys in $text", ({ text, keys, cursor }) => {
    expect(normalMode(text, keys).getCursor()).toEqual(cursor);
  });

  test.each([
    { name: "h at a line start", text: "one\ntwo", keys: "0h", cursor: { line: 1, col: 0 } },
    { name: "l at a line end", text: "one\ntwo", keys: "k$l", cursor: { line: 0, col: 2 } },
    { name: "l on an empty line", text: "\nabc", keys: "kl", cursor: { line: 0, col: 0 } },
  ])("keeps $name within the line", ({ text, keys, cursor }) => {
    expect(normalMode(text, keys).getCursor()).toEqual(cursor);
  });

  test.each([
    { keys: "iX", text: "ab", expected: "aXb" },
    { keys: "aX", text: "ab", expected: "abX" },
    { keys: "AX", text: "ab", expected: "abX" },
    { keys: "0AX", text: "ab", expected: "abX" },
    { keys: "IX", text: "ab", expected: "Xab" },
    { keys: "kaX", text: "\nab", expected: "X\nab" },
    { keys: "otwo", text: "one", expected: "one\ntwo" },
    { keys: "Oone", text: "two", expected: "one\ntwo" },
    { keys: "Otwo", text: "one\nthree", expected: "one\ntwo\nthree" },
    { keys: "0wC!", text: "one two", expected: "one !" },
    { keys: "kccnew", text: "one\ntwo", expected: "new\ntwo" },
    { keys: "0cwred", text: "one two", expected: "red two" },
    { keys: "hciwred", text: "one two", expected: "one red" },
  ])("enters Insert mode with $keys", ({ keys, text, expected }) => {
    const editor = normalMode(text, keys);

    expect(editor.getText()).toBe(expected);
    expectLabel(editor, "INSERT");
  });

  test.each([
    { keys: "x", text: "abc", expected: "ab" },
    { keys: "xu", text: "abc", expected: "abc" },
    { keys: "0wD", text: "one two", expected: "one " },
    { keys: "kdd", text: "one\ntwo", expected: "two" },
    { keys: "dd", text: "one\ntwo", expected: "one" },
    { keys: "kdd", text: "one\n\nthree", expected: "one\nthree" },
    { keys: "kdd", text: "one\n\n", expected: "one\n" },
    { keys: "kdd", text: "\nabc", expected: "abc" },
    { keys: "dd", text: "one", expected: "" },
    { keys: "dd", text: "", expected: "" },
    { keys: "0dw", text: "one two", expected: " two" },
    { keys: "hdiw", text: "one two", expected: "one " },
    { keys: "0ldiw", text: "one two", expected: " two" },
    { keys: "hhhdiw", text: "one.two", expected: "onetwo" },
  ])("edits with $keys in $text", ({ keys, text, expected }) => {
    const editor = normalMode(text, keys);

    expect(editor.getText()).toBe(expected);
    expectLabel(editor, "NORMAL");
  });

  test.each([
    { name: "x on an empty line", keys: "kx" },
    { name: "D on an empty line", keys: "kD" },
    { name: "dw on an empty line", keys: "kdw" },
    { name: "diw on an empty line", keys: "kdiw" },
    { name: "diw on whitespace", keys: "0diw" },
    { name: "an unknown key", keys: "q" },
    { name: "an unknown operator target", keys: "dqciqdiq" },
    { name: "whitespace", keys: " " },
  ])("leaves the text alone for $name", ({ keys }) => {
    const editor = normalMode("\n one", keys);

    expect(editor.getText()).toBe("\n one");
    expectLabel(editor, "NORMAL");
  });

  test("shows a pending command in the border until it completes or is cancelled", () => {
    const editor = normalMode("one", "d");
    expectLabel(editor, "NORMAL d");
    typeKeys(editor, "i");
    expectLabel(editor, "NORMAL di");

    editor.handleInput(keyboard.escape);
    expectLabel(editor, "NORMAL");
    typeKeys(editor, "w");
    expect(editor.getText()).toBe("one");
  });

  test("cancels a pending command on a control key without passing it to Pi", () => {
    const editor = normalMode("one", "d");
    const submissions: string[] = [];
    editor.onSubmit = (text) => submissions.push(text);

    editor.handleInput("\r");

    expect(submissions).toEqual([]);
    expectLabel(editor, "NORMAL");
  });
});

describe("VimEditor inside Pi", () => {
  function normalMode(text: string): CustomEditor {
    const editor = createEditor();
    editor.setText(text);
    editor.handleInput("\x1b");
    return editor;
  }

  test("does not install an editor outside TUI mode", () => {
    expect(installedEditorFactory("rpc")).toBeUndefined();
  });

  test("returns to Insert mode after Pi accepts a submission", () => {
    const editor = normalMode("submit me");
    const submissions: string[] = [];
    editor.onSubmit = (text) => submissions.push(text);

    editor.handleInput("\r");

    expect(submissions).toEqual(["submit me"]);
    expectLabel(editor, "INSERT");
  });

  test("stays in Normal mode after submitting an empty editor", () => {
    const editor = normalMode("");

    editor.handleInput("\r");

    expectLabel(editor, "NORMAL");
  });

  test("passes control keys to Pi and keeps the cursor on a character", () => {
    const editor = normalMode("one\ntwo");

    editor.handleInput("\x1b[A");
    expect(editor.getCursor()).toEqual({ line: 0, col: 2 });
    editor.handleInput("\x05");
    expect(editor.getCursor()).toEqual({ line: 0, col: 2 });
  });

  test("ignores pasted or multi-character printable input in Normal mode", () => {
    const editor = normalMode("one");

    editor.handleInput("dd");
    editor.handleInput("constructor");

    expect(editor.getText()).toBe("one");
    expectLabel(editor, "NORMAL");
  });

  test("performs commands when the user has rebound Pi's editor keys", () => {
    const configured = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.editor.cursorLeft": [],
      "tui.editor.cursorLineStart": "ctrl+x",
      "tui.editor.deleteCharForward": [],
      "tui.editor.deleteToLineEnd": "ctrl+a",
      "tui.editor.undo": "ctrl+z",
    });
    setKeybindings(configured);
    const editor = normalMode("one two");

    for (const key of "0xD") editor.handleInput(key);
    expect(editor.getText()).toBe("");
    for (const key of "uu") editor.handleInput(key);
    expect(editor.getText()).toBe("one two");
    expect(getKeybindings()).toBe(configured);
  });

  test("performs commands without offering their input to app or extension shortcuts", () => {
    const editor = normalMode("one two");
    const claimed: string[] = [];
    editor.onExtensionShortcut = (data) => {
      claimed.push(data);
      return true;
    };

    for (const key of "0dw") editor.handleInput(key);

    expect(editor.getText()).toBe(" two");
    expect(claimed).toEqual([]);
  });

  test("closes an open autocomplete list when escape leaves Insert mode", async () => {
    const provider: AutocompleteProvider = {
      getSuggestions: async () => ({
        items: [
          { value: "/model", label: "model" },
          { value: "/mode", label: "mode" },
        ],
        prefix: "/",
      }),
      applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
    };
    const editor = createEditor();
    editor.setAutocompleteProvider(provider);
    editor.handleInput("/");
    await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
    // The list renders below the border, so the label stays off its last item.
    expect(editor.render(60).at(-1)?.endsWith(" INSERT ")).toBe(false);

    editor.handleInput("\x1b");

    expect(editor.isShowingAutocomplete()).toBe(false);
    expectLabel(editor, "NORMAL");
  });

  test("leaves a border unchanged when it is too narrow for the mode label", () => {
    const editor = createEditor();

    expect(editor.render(7).at(-1)).toBe("─".repeat(7));
    expect(editor.render(8).at(-1)).toBe(" INSERT ");
  });
});
