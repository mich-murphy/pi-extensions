import { TuiMainScreen } from "@earendil-works/pi-tui";
import type { Terminal, TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

/** Build a real Pi TUI without touching the host terminal. */
export function testTui(): TUI {
  const terminal: Terminal = {
    columns: 120,
    rows: 40,
    kittyProtocolActive: false,
    start: () => undefined,
    stop: () => undefined,
    drainInput: async () => undefined,
    write: () => undefined,
    moveBy: () => undefined,
    hideCursor: () => undefined,
    showCursor: () => undefined,
    clearLine: () => undefined,
    clearFromCursor: () => undefined,
    clearScreen: () => undefined,
    setTitle: () => undefined,
    setProgress: () => undefined,
    setProgramStatus: () => undefined,
  };
  return new TuiMainScreen(terminal);
}

/** Build Pi's application keybindings, not just its TUI bindings. */
export function testKeybindings(): KeybindingsManager {
  return new KeybindingsManager({ "app.interrupt": "escape" });
}

/** Return the real active Pi theme after initTheme has initialized it. */
export function testTheme() {
  return theme;
}
