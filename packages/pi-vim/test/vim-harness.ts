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

type SessionStartHandler = Parameters<VimRegistration["on"]>[1];
export type EditorFactory = NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]>;

export function installedEditorFactory(mode: ExtensionContext["mode"]): EditorFactory | undefined {
  let sessionStart: SessionStartHandler | undefined;
  const piDouble = {
    on(event: string, handler: SessionStartHandler): void {
      if (event === "session_start") {
        sessionStart = handler;
      }
    },
  };
  vimMode(piDouble);
  if (!sessionStart) {
    throw new Error("Vim extension did not register session_start");
  }

  let editorFactory: EditorFactory | undefined;
  const contextDouble = {
    mode,
    ui: {
      setEditorComponent(factory: EditorFactory): void {
        editorFactory = factory;
      },
    },
  };
  sessionStart({}, contextDouble);
  return editorFactory;
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

/** Kitty reports every key as CSI-u, with the shifted character as an alternate key. */
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
