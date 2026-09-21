import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  Editor,
  getKeybindings,
  KeybindingsManager,
  matchesKey,
  setKeybindings,
  TUI_KEYBINDINGS,
  truncateToWidth,
} from "@earendil-works/pi-tui";

/** The cursor and its surroundings: everything an action or command may depend on. */
type View = {
  readonly line: number;
  readonly col: number;
  /** Text of the cursor line. */
  readonly text: string;
  readonly lineCount: number;
};
type Guard = (view: View) => boolean;

/**
 * A base-editor action, named by the terminal input Pi's default keybindings map to it. Pi's
 * actions wrap and join across line boundaries where Vim's stay within the line, so each action
 * carries the guard that keeps it to the Vim behavior its name promises.
 */
type Action = { readonly input: string; readonly when: Guard; readonly repeats: boolean };

const always: Guard = () => true;
const inLine: Guard = (view) => view.col < view.text.length;
const onLastLine: Guard = (view) => view.line >= view.lineCount - 1;
/** The end of a line counts as blank, so word motions continue onto the next line. */
const onBlank: Guard = (view) => !/\S/u.test(view.text.slice(view.col, view.col + 1));

const once = (input: string, when: Guard = always): Action => ({ input, when, repeats: false });
const repeatedly = (input: string, when: Guard): Action => ({ input, when, repeats: true });

const ACTIONS = {
  left: once("\x1b[D", (view) => view.col > 0),
  right: once("\x1b[C", inLine),
  up: once("\x1b[A"),
  down: once("\x1b[B"),
  lineStart: once("\x01"),
  lineEnd: once("\x05"),
  wordLeft: once("\x1b[1;3D"),
  wordRight: once("\x1b[1;3C", (view) => !onBlank(view)),
  skipBlanks: repeatedly("\x1b[C", (view) => onBlank(view) && (inLine(view) || !onLastLine(view))),
  newline: once("\n"),
  deleteChar: once("\x1b[3~", inLine),
  deleteWord: once("\x1b[3;3~", inLine),
  deleteToLineEnd: once("\x0b", inLine),
  joinNextLine: once("\x1b[3~", (view) => !inLine(view)),
  joinPreviousLine: once("\x7f", (view) => view.col === 0),
  undo: once("\x1f"),
  /** Normal mode keeps the cursor on a character, never after the last one. */
  clamp: once("\x1b[D", (view) => view.col > 0 && !inLine(view)),
} satisfies Record<string, Action>;
type ActionName = keyof typeof ACTIONS;

/** Actions run under these bindings, so a user's remapped keys cannot redirect them. */
const DEFAULT_KEYBINDINGS = new KeybindingsManager(TUI_KEYBINDINGS);

/** A Normal-mode command: the actions to perform, then the mode to continue in. */
type Command = {
  readonly mode: "insert" | "normal";
  readonly steps: (view: View) => ReadonlyArray<ActionName>;
};

const insert = (...steps: ReadonlyArray<ActionName>): Command => ({
  mode: "insert",
  steps: () => steps,
});
const normal = (...steps: ReadonlyArray<ActionName>): Command => ({
  mode: "normal",
  steps: () => steps,
});
/** Pi's word boundaries find the word under the cursor. A blank has no word, so it is left alone. */
const innerWord: Command["steps"] = (view) =>
  onBlank(view) ? [] : ["wordRight", "wordLeft", "deleteWord"];
const wholeLine: Command["steps"] = (view) => [
  "lineStart",
  "deleteToLineEnd",
  onLastLine(view) ? "joinPreviousLine" : "joinNextLine",
];

/** Every binding, keyed by its full key sequence. A sequence's proper prefixes are pending states. */
const COMMANDS: ReadonlyMap<string, Command> = new Map(
  Object.entries<Command>({
    i: insert(),
    a: insert("right"),
    A: insert("lineEnd"),
    I: insert("lineStart"),
    o: insert("lineEnd", "newline"),
    O: insert("lineStart", "newline", "up"),
    h: normal("left"),
    j: normal("down"),
    k: normal("up"),
    l: normal("right"),
    w: normal("wordRight", "skipBlanks"),
    b: normal("wordLeft"),
    "0": normal("lineStart"),
    $: normal("lineEnd"),
    x: normal("deleteChar"),
    D: normal("deleteToLineEnd"),
    C: insert("deleteToLineEnd"),
    u: normal("undo"),
    dd: { mode: "normal", steps: wholeLine },
    dw: normal("deleteWord"),
    diw: { mode: "normal", steps: innerWord },
    cc: insert("lineStart", "deleteToLineEnd"),
    cw: insert("deleteWord"),
    ciw: { mode: "insert", steps: innerWord },
  }),
);

/** `pending` holds the keys typed so far of an unfinished command, or "" when there are none. */
type VimState = { readonly mode: "insert" } | { readonly mode: "normal"; readonly pending: string };

const INSERT: VimState = { mode: "insert" };
const NORMAL: VimState = { mode: "normal", pending: "" };

function modeLabel(state: VimState): string {
  if (state.mode === "insert") return " INSERT ";
  return state.pending === "" ? " NORMAL " : ` NORMAL ${state.pending} `;
}

/** The text this input types, or undefined for control and navigation keys. */
function printableText(data: string): string | undefined {
  const decoded = decodeKittyPrintable(data);
  if (decoded !== undefined) return decoded;
  const code = data.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f ? data : undefined;
}

/** Pi's main prompt editor with a deliberately small set of Vim bindings. */
class VimEditor extends CustomEditor {
  private vimState: VimState = INSERT;

  override handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+[")) {
      this.handleEscape(data);
      return;
    }
    if (this.vimState.mode === "insert") {
      super.handleInput(data);
      return;
    }

    // Printable input belongs to Vim and never reaches Pi. Everything else is Pi's, unless it
    // interrupts a pending command. One character is a key press. Longer text is a paste the
    // terminal did not bracket, which must not run as commands.
    const text = printableText(data);
    if (text !== undefined && [...text].length === 1) {
      this.handleSequence(this.vimState.pending + text);
    } else if (text !== undefined || this.vimState.pending !== "") {
      this.vimState = NORMAL;
    } else {
      this.passToPi(data);
    }
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    const lastLine = lines.at(-1);
    const label = modeLabel(this.vimState);
    // An open autocomplete list renders below the border, where a label would cover an item.
    if (lastLine === undefined || this.isShowingAutocomplete() || width < label.length)
      return lines;

    lines[lines.length - 1] =
      truncateToWidth(lastLine, width - label.length, "") + this.borderColor(label);
    return lines;
  }

  private handleEscape(data: string): void {
    if (this.vimState.mode === "normal" && this.vimState.pending === "") {
      super.handleInput(data);
      return;
    }
    if (this.vimState.mode === "insert") {
      if (this.isShowingAutocomplete()) super.handleInput(data);
      this.perform("left");
    }
    this.vimState = NORMAL;
  }

  private handleSequence(sequence: string): void {
    const command = COMMANDS.get(sequence);
    if (command === undefined) {
      const isPrefix = [...COMMANDS.keys()].some((keys) => keys.startsWith(sequence));
      this.vimState = { mode: "normal", pending: isPrefix ? sequence : "" };
      return;
    }

    for (const step of command.steps(this.view())) this.perform(step);
    if (command.mode === "insert") {
      this.vimState = INSERT;
      return;
    }
    this.vimState = NORMAL;
    this.perform("clamp");
  }

  private passToPi(data: string): void {
    const hadText = this.getText().length > 0;
    super.handleInput(data);
    // Pi empties the editor when it accepts a submission. The next prompt starts in Insert mode.
    if (hadText && this.getText().length === 0) this.vimState = INSERT;
    else this.perform("clamp");
  }

  private perform(name: ActionName): void {
    const { input, when, repeats } = ACTIONS[name];
    for (let view = this.view(); when(view); ) {
      this.performInput(input);
      const next = this.view();
      // A repeating action ends when its guard fails or when the cursor stops moving.
      if (!repeats || (next.line === view.line && next.col === view.col)) return;
      view = next;
    }
  }

  /**
   * Send input straight to the base editor under Pi's default keybindings. Going through
   * `super` would let app shortcuts and extension shortcuts claim it first.
   */
  private performInput(input: string): void {
    const configured = getKeybindings();
    setKeybindings(DEFAULT_KEYBINDINGS);
    try {
      Editor.prototype.handleInput.call(this, input);
    } finally {
      setKeybindings(configured);
    }
  }

  private view(): View {
    const { line, col } = this.getCursor();
    const lines = this.getLines();
    return { line, col, text: lines[line] ?? "", lineCount: lines.length };
  }
}

/** Register Vim-style modal editing for Pi's interactive prompt composer. */
export default function vimMode(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new VimEditor(tui, theme, keybindings));
  });
}
