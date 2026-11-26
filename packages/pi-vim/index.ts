import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
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
import { onOffCommand } from "../shared/on-off-command";
import type { OnOffCommand } from "../shared/on-off-command";

type View = {
  readonly line: number;
  readonly col: number;
  readonly text: string;
  readonly lineCount: number;
};

type Guard = (view: View) => boolean;

type Action = { readonly input: string; readonly when: Guard; readonly repeats: boolean };

const always: Guard = () => true;
const inLine: Guard = (view) => view.col < view.text.length;
const onLastLine: Guard = (view) => view.line >= view.lineCount - 1;
const onBlank: Guard = (view) => !/\S/u.test(view.text.slice(view.col, view.col + 1));

const once = (input: string, when: Guard = always): Action => ({ input, when, repeats: false });
const repeatedly = (input: string, when: Guard): Action => ({ input, when, repeats: true });

const ACTIONS = {
  left: once("\u001B[D", (view) => view.col > 0),
  right: once("\u001B[C", inLine),
  up: once("\u001B[A"),
  down: once("\u001B[B"),
  lineStart: once("\u0001"),
  lineEnd: once("\u0005"),
  wordLeft: once("\u001B[1;3D"),
  wordRight: once("\u001B[1;3C", (view) => !onBlank(view)),
  skipBlanks: repeatedly(
    "\u001B[C",
    (view) => onBlank(view) && (inLine(view) || !onLastLine(view)),
  ),
  newline: once("\n"),
  deleteChar: once("\u001B[3~", inLine),
  deleteWord: once("\u001B[3;3~", inLine),
  deleteToLineEnd: once("\u000B", inLine),
  joinNextLine: once("\u001B[3~", (view) => !inLine(view)),
  joinPreviousLine: once("\u007F", (view) => view.col === 0),
  undo: once("\u001F"),
  clamp: once("\u001B[D", (view) => view.col > 0 && !inLine(view)),
} satisfies Record<string, Action>;

type ActionName = keyof typeof ACTIONS;

const DEFAULT_KEYBINDINGS = new KeybindingsManager(TUI_KEYBINDINGS);

type Command = {
  readonly mode: "insert" | "normal";
  readonly steps: (view: View) => readonly ActionName[];
};

const insert = (...steps: readonly ActionName[]): Command => ({
  mode: "insert",
  steps: () => steps,
});

const normal = (...steps: readonly ActionName[]): Command => ({
  mode: "normal",
  steps: () => steps,
});

const innerWord: Command["steps"] = (view) =>
  onBlank(view) ? [] : ["wordRight", "wordLeft", "deleteWord"];

const wholeLine: Command["steps"] = (view) => [
  "lineStart",
  "deleteToLineEnd",
  onLastLine(view) ? "joinPreviousLine" : "joinNextLine",
];

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

const PENDING_SEQUENCES: ReadonlySet<string> = new Set(
  [...COMMANDS.keys()].flatMap((keys) =>
    Array.from({ length: keys.length - 1 }, (_, index) => keys.slice(0, index + 1)),
  ),
);

type VimState = { readonly mode: "insert" } | { readonly mode: "normal"; readonly pending: string };

const INSERT: VimState = { mode: "insert" };
const NORMAL: VimState = { mode: "normal", pending: "" };

function modeLabel(state: VimState): string {
  if (state.mode === "insert") {
    return " INSERT ";
  }

  return state.pending === "" ? " NORMAL " : ` NORMAL ${state.pending} `;
}

const MAX_UNICODE_CODE_POINT = 1_114_111;

function decodeXtermPrintable(data: string): string | undefined {
  const prefix = "\u001B[27;";

  if (!data.startsWith(prefix)) {
    return undefined;
  }

  const match = /^(?<modifier>1|2);(?<codePoint>[1-9]\d*)~$/u.exec(data.slice(prefix.length));
  const codePoint = Number(match?.groups?.codePoint);

  if (!match || !Number.isSafeInteger(codePoint) || codePoint > MAX_UNICODE_CODE_POINT) {
    return undefined;
  }

  const text = String.fromCodePoint(codePoint);

  return /^\P{C}$/u.test(text) ? text : undefined;
}

function printableText(data: string): string | undefined {
  const decoded = decodeKittyPrintable(data) ?? decodeXtermPrintable(data);

  if (decoded !== undefined) {
    return decoded;
  }

  const code = data.codePointAt(0);

  return code !== undefined && code >= 0x20 && code !== 0x7f ? data : undefined;
}

function isOneCodePoint(text: string): boolean {
  const code = text.codePointAt(0);

  return code !== undefined && String.fromCodePoint(code).length === text.length;
}

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

    const text = printableText(data);

    if (text !== undefined && isOneCodePoint(text)) {
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

    if (lastLine === undefined || this.isShowingAutocomplete() || width < label.length) {
      return lines;
    }

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
      if (this.isShowingAutocomplete()) {
        this.performInput("\u001B");
      }

      this.perform("left");
    }

    this.vimState = NORMAL;
  }

  private handleSequence(sequence: string): void {
    const command = COMMANDS.get(sequence);

    if (command === undefined) {
      this.vimState = { mode: "normal", pending: PENDING_SEQUENCES.has(sequence) ? sequence : "" };

      return;
    }

    for (const step of command.steps(this.view())) {
      this.perform(step);
    }

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

    if (hadText && this.getText().length === 0) {
      this.vimState = INSERT;
    } else {
      this.perform("clamp");
    }
  }

  private perform(name: ActionName): void {
    const { input, when, repeats } = ACTIONS[name];

    for (let view = this.view(); when(view);) {
      this.performInput(input);
      const next = this.view();

      if (!repeats || (next.line === view.line && next.col === view.col)) {
        return;
      }

      view = next;
    }
  }

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

export type EditorFactory = (
  ...args: Parameters<NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>>
) => CustomEditor;

export type VimRegistration = {
  readonly on: (
    name: "session_start",
    handler: (
      event: SessionStartEvent,
      ctx: Pick<ExtensionContext, "mode"> & {
        readonly ui: Pick<VimCommandContext["ui"], "setEditorComponent">;
      },
    ) => void,
  ) => void;
  readonly registerCommand: (name: "vim", options: OnOffCommand<VimCommandContext>) => void;
};

export type VimCommandContext = Pick<ExtensionContext, "mode"> & {
  readonly ui: Pick<ExtensionContext["ui"], "notify"> & {
    readonly setEditorComponent: (factory: EditorFactory | undefined) => void;
  };
};

const vimEditor: EditorFactory = (tui, theme, keybindings) =>
  new VimEditor(tui, theme, keybindings);

export default function vimMode(pi: VimRegistration): void {
  let enabled = true;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !enabled) {
      return;
    }

    ctx.ui.setEditorComponent(vimEditor);
  });

  pi.registerCommand(
    "vim",
    onOffCommand<VimCommandContext>({
      name: "vim",
      label: "Vim",
      description: "Turn Vim keys in the prompt editor on or off for this session",
      enabled: () => enabled,
      apply: (next, ctx) => {
        enabled = next;

        if (ctx.mode === "tui") {
          ctx.ui.setEditorComponent(enabled ? vimEditor : undefined);
        }
      },
    }),
  );
}
