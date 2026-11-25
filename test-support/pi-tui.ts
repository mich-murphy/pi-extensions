import { TuiMainScreen } from "@earendil-works/pi-tui";
import type { Terminal, TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

export function testTui(rows = 40): TUI {
  const terminal: Terminal = {
    columns: 120,
    rows,
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

export function testKeybindings(): KeybindingsManager {
  return new KeybindingsManager({ "app.interrupt": "escape" });
}

export function testTheme() {
  return theme;
}
