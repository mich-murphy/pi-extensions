// Generators, extractors and properties for setup.bombadil.ts.
import { always, eventually, next, now } from "@antithesishq/bombadil";
import type { Formula } from "@antithesishq/bombadil";
import { CharSet } from "@antithesishq/bombadil/actions";
import { actions, extract, weighted } from "@antithesishq/bombadil/terminal";
import type { State } from "@antithesishq/bombadil/terminal";
import { CharSets, typeFromSet } from "@antithesishq/bombadil/terminal/defaults/actions";
import {
  dialogBorderShown,
  dialogKind,
  screenRows,
  typedText,
} from "../../../../test-support/bombadil-screen.ts";

const ESCAPE = "\u001B";
const ui = extract((state: State) => {
  const rows = screenRows(state).map((row) => row.trim());
  return {
    dialog: dialogKind(rows),
    border: dialogBorderShown(rows),
    cursors: rows.filter((row) => row.startsWith("→ ")).length,
    probe: rows.find((row) => row.startsWith("probe:")) ?? null,
  };
});

const exitStatus = extract((state: State) => state.exitStatus);

/** The text the last action typed, or null for anything else. */
const lastKey = extract((state: State) => typedText(state));

export const inDialog = (): boolean => (ui.current?.dialog ?? null) !== null;

// Outside a dialog: clear the editor (Ctrl+U) and type a /peers command, then Enter. The first
// Enter may only accept the autocomplete entry, so Enter is common. No other keys: \"!\" would run a
// shell, Ctrl+C/D exit, and other slash commands open Pi's own selectors.
export const commands = actions(() =>
  inDialog()
    ? []
    : [
        { TypeText: { Regexp: String.raw`\x15/peers (setup|setup|setup|reset|doctor|status)` } },
        { TypeText: { CharSet: CharSet.fromLiterals("\r") } },
        { TypeText: { CharSet: CharSet.fromLiterals("\r") } },
      ],
);

// Inside a dialog: move, confirm, cancel, or type an answer. Answers mix well-formed values (so
// the flow goes deeper) with arbitrary text (so validation is exercised).
const ANSWER = String.raw`127\.0\.0\.1:[0-9]{1,5}|\[::1\]:[0-9]{2,5}|[a-z][a-z0-9-]{0,12}|/[a-z]{1,8}(/[a-z.]{1,8}){0,2}|[0-9a-f]{64}|[A-Za-z ]{0,20}`;
export const dialogKeys = weighted([
  [30, typeFromSet(CharSet.fromLiterals("\u001B[B", "\u001B[A", "j", "k"))],
  [20, typeFromSet(CharSet.fromLiterals("\r"))],
  [4, typeFromSet(CharSet.fromLiterals(ESCAPE))],
  [12, actions(() => (ui.current?.dialog === "input" ? [{ TypeText: { Regexp: ANSWER } }] : []))],
  [6, typeFromSet(CharSets.UNICODE_SAFE)],
  [4, typeFromSet(CharSet.fromLiterals("\u007F", "\u0015"))],
]).when(inDialog);

// Pi's fullscreen layout cuts off the bottom of a screen taller than the terminal. Onboarding
// dialogs are sized to fit 80x20 with the footer and probe row, so probeShown and dialogFits check
// down to 20 rows.
export const resize = actions(() => [{ Resize: { columns: [80, 140], rows: [20, 50] } }]);

/** Pi never exits or crashes: no key in the generator asks it to. */
export const piKeepsRunning: Formula = always(() => exitStatus.current === null);

/**
 * The probe is loaded and reporting; without it, noUnreviewedWrite would pass vacuously. It is the
 * last footer row, so a dialog too tall for the terminal also pushes it off screen.
 */
export const probeShown: Formula = always(() => (ui.current?.probe ?? null) !== null);

/** Every dialog shows its bottom border below the hint row: nothing is cut off. */
export const dialogFits: Formula = always(() => !inDialog() || (ui.current?.border ?? false));

/**
 * The fuzzer reaches a dialog. Dialogs are recognised by Pi's hint text, so if Pi renames it the
 * dialog properties would pass without checking anything; this fails instead.
 */
export const dialogReached: Formula = eventually(inDialog).within(30, "seconds");

/** No /peers command writes under the agent directory or home before an Apply option is chosen. */
export const noUnreviewedWrite: Formula = always(
  () => !(ui.current?.probe ?? "").startsWith("probe:UNREVIEWED-WRITE"),
);

/** No /peers command changes or deletes an existing path before an Apply option is chosen. */
export const noUnreviewedChange: Formula = always(
  () => !(ui.current?.probe ?? "").startsWith("probe:UNREVIEWED-CHANGE"),
);

/** Escape in any onboarding dialog cancels it: the next state shows no dialog. */
export const escapeClosesDialog: Formula = always(
  now(inDialog).implies(next(() => lastKey.current !== ESCAPE || !inDialog())),
);

/** A select dialog always shows exactly one highlighted option, at every terminal size. */
export const selectionVisible: Formula = always(
  () => ui.current?.dialog !== "select" || ui.current.cursors === 1,
);
