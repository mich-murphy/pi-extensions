import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  setKeybindings,
  setKittyProtocolActive,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import type { EditorTheme } from "@earendil-works/pi-tui";
import { testTui, testKeybindings } from "../../../test-support/pi-tui";
import vimMode from "../index";
import type { VimRegistration } from "../index";

const identity = (text: string): string => text;

export const theme: EditorTheme = {
  borderColor: identity,
  selectList: {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  },
};

type SessionStartHandler = Parameters<VimRegistration["on"]>[1];

export type VimCommand = Parameters<VimRegistration["registerCommand"]>[1];

export type EditorFactory = NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]>;

export type Notice = { readonly message: string; readonly type: string | undefined };

export type VimSession = {
  readonly editors: (EditorFactory | undefined)[];
  readonly notices: Notice[];
  readonly command: VimCommand;
  readonly startSession: () => void;
  readonly runCommand: (args: string) => Promise<void>;
};

export function loadVim(mode: ExtensionContext["mode"]): VimSession {
  let sessionStart: SessionStartHandler | undefined;
  let command: VimCommand | undefined;

  const piDouble: VimRegistration = {
    on(event, handler): void {
      if (event === "session_start") {
        sessionStart = handler;
      }
    },
    registerCommand(name, options): void {
      if (name === "vim") {
        command = options;
      }
    },
  };

  vimMode(piDouble);

  if (!sessionStart) {
    throw new Error("Vim extension did not register session_start");
  }

  if (!command) {
    throw new Error("Vim extension did not register /vim");
  }

  const editors: (EditorFactory | undefined)[] = [];
  const notices: Notice[] = [];

  const contextDouble = {
    mode,
    ui: {
      setEditorComponent(factory: EditorFactory | undefined): void {
        editors.push(factory);
      },
      notify(message: string, type?: "info" | "warning" | "error"): void {
        notices.push({ message, type });
      },
    },
  };

  const start = sessionStart;
  const registered = command;

  return {
    editors,
    notices,
    command: registered,
    startSession: () => {
      start({ type: "session_start", reason: "startup" }, contextDouble);
    },
    runCommand: async (args) => registered.handler(args, contextDouble),
  };
}

export function installedEditorFactory(mode: ExtensionContext["mode"]): EditorFactory | undefined {
  const session = loadVim(mode);
  session.startSession();

  return session.editors.at(-1);
}

export function createEditor(): CustomEditor {
  const editorFactory = installedEditorFactory("tui");

  if (!editorFactory) {
    throw new Error("Vim extension did not install an editor factory");
  }

  const tuiDouble = testTui();
  const tuiKeybindings = testKeybindings();
  const editor = editorFactory(tuiDouble, theme, tuiKeybindings);

  if (!(editor instanceof CustomEditor)) {
    throw new TypeError("Vim factory returned an unsupported editor");
  }

  return editor;
}

export type Keyboard = {
  readonly name: string;
  readonly kittyProtocol: boolean;
  readonly escape: string;
  readonly press: (key: string) => string;
};

const SHIFTED_SYMBOL_BASE_KEYS: ReadonlyMap<string, string> = new Map([["$", "4"]]);

export function kittyPress(key: string): string {
  const base = SHIFTED_SYMBOL_BASE_KEYS.get(key) ?? key.toLowerCase();
  const code = key.codePointAt(0);

  return base === key ? `\u001B[${code}u` : `\u001B[${base.codePointAt(0)}:${code};2u`;
}

export const KEYBOARDS: readonly Keyboard[] = [
  { name: "legacy", kittyProtocol: false, escape: "\u001B", press: identity },
  { name: "Kitty", kittyProtocol: true, escape: "\u001B[27u", press: kittyPress },
];

export function resetKeyboard(): void {
  setKittyProtocolActive(false);
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
}
