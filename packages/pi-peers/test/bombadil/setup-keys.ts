// Extractors, generators and properties shared by the /peers menu suites: setup.bombadil.ts
// (refusing backend) and setup-success.bombadil.ts (copied debug gateway). The screen is read by
// peers-screen.ts, which follows the screen contract in the peers-setup-ux brief.
//
// End-of-run gap: Bombadil stops at the time limit and passes any obligation still open, bounded
// or not (checked with `eventually(() => false)`: exit 0 at the limit), and it has no option to
// fail pending obligations instead. So an `eventually(…).within(N)` opened in the last N seconds
// of a run is never judged. The time-bounded guards below are therefore set well inside each
// suite's default time limit, and the always/eventually properties hold for every obligation
// opened earlier than that.
import { always, eventually, next } from "@antithesishq/bombadil";
import type { Formula } from "@antithesishq/bombadil";
import { CharSet } from "@antithesishq/bombadil/actions";
import { actions, extract, weighted } from "@antithesishq/bombadil/terminal";
import type { ActionTemplate, State } from "@antithesishq/bombadil/terminal";
import { CharSets, typeFromSet } from "@antithesishq/bombadil/terminal/defaults/actions";
import {
  escapeGoesBack as escapeLandsOn,
  menuFits as fitsFrom,
  oneHighlight,
} from "../../../../test-support/bombadil-menu-properties.ts";
import { screenRows, typedText } from "../../../../test-support/bombadil-screen.ts";
import { readPeers } from "./peers-screen.ts";
import type { ListRow, PeersView } from "./peers-screen.ts";

export const ESCAPE = "\u001B";
export const ENTER = "\r";
export const UP = "\u001B[A";
export const DOWN = "\u001B[B";
const SETTING_UP = "Peers: setting up…";
// The consent rows towardApply steers to; a row whose value says it is not ready is skipped.
const CONSENT_ROWS = new Set([
  "Apply",
  "Restart and activate",
  "Repair installation",
  "Add peer",
  "Import bundle",
  "Turn off peers",
]);
const NOT_READY = /^(?:No changes|Missing: |Invalid: |Blocked: )/u;
// Root-action outcome headlines, by the breadcrumb their outcome view must carry.
const ROOT_OUTCOMES: Readonly<Record<string, RegExp>> = {
  "Peers › Reconnect › Result": /^(?:✓ Reconnected — |✗ Reconnect failed — |✗ Failed — )/u,
  "Peers › Reset › Result":
    /^(?:✓ Peers turned off|✗ Reset refused — |✗ Reset partly done — |✗ Failed — )/u,
};

export type Screen = PeersView & {
  /** A `/peers status` report headline `Connected as …` is on screen. */
  connectedShown: boolean;
};

export function readScreen(state: State): Screen {
  const rows = screenRows(state).map((row) => row.trim());
  return {
    ...readPeers(rows, state.grid.size.rows),
    connectedShown: rows.some((row) => row.includes("Connected as ")),
  };
}

export const ui = extract((state: State) => readScreen(state));
/** The current screen, or undefined before the first state is extracted. */
const screenNow = (): Screen | undefined => ui.current;
const exitStatus = extract((state: State) => state.exitStatus);
/** The text the last action typed, or null for anything else. */
export const lastKey = extract((state: State) => typedText(state));

export const menuOpen = (): boolean =>
  screenNow()?.titleShown === true || screenNow()?.hintShown === true;
export const idle = (): boolean => !menuOpen();
const editing = (): boolean => ui.current?.kind === "editor";
const working = (): boolean => ui.current?.kind === "progress";
// Sticky: whether an outcome headline has been on screen yet.
let outcomeSeenOnce = false;
const outcomeSeen = extract((state: State) => {
  outcomeSeenOnce ||= readScreen(state).outcome !== null;
  return outcomeSeenOnce;
});
// Esc's weight while a progress view shows. Esc there hides the menu, so at the list weight nearly
// every Apply was hidden before its outcome drew (the refusing backend takes 1.5 s) and
// outcomeShown starved. So progress is never hidden before the first outcome, then hidden at this
// weight: about one progress view in eight gets Esc, so most Applies still end in their outcome
// while escapeGoesBack and footerAgrees still see the hidden case.
const PROGRESS_ESCAPE = 3;
const hideable = (): boolean => working() && (outcomeSeen.current ?? false);

export const key = (text: string): ActionTemplate => ({
  TypeText: { CharSet: CharSet.fromLiterals(text) },
});
/** Clears the editor (Ctrl+U) and types `/peers<suffix>`; Enter is a separate action. */
export const command = (suffix: string): ActionTemplate => ({
  TypeText: { Regexp: `${String.raw`\x15/peers`}${suffix}` },
});

// With no menu open: type a /peers command, or Enter. No other keys: "!" would run a shell,
// Ctrl+C/D exit, and other slash commands open Pi's own selectors.
export function commands(weights: {
  bare: number;
  setup: number;
  status: number;
  reset: number;
  doctor: number;
}) {
  return weighted([
    [weights.bare, command("")],
    [weights.setup, command(" setup")],
    [weights.status, command(" status")],
    [weights.reset, command(" reset")],
    [weights.doctor, command(" doctor")],
    [10, key(ENTER)],
  ]).when(idle);
}

// Answers mix well-formed values (so a form goes deeper) with arbitrary text (so validation runs).
const ANSWER = String.raw`127\.0\.0\.1:[0-9]{1,5}|\[::1\]:[0-9]{2,5}|[a-z][a-z0-9-]{0,12}|/[a-z]{1,8}(/[a-z.]{1,8}){0,2}|[0-9a-f]{64}|[A-Za-z ]{0,20}`;
const NAVIGATE = CharSet.fromLiterals(UP, DOWN, "j", "k", "\u001B[5~", "\u001B[6~");

/**
 * Keys while the menu is open: navigation, Enter, Space (confirms in lists), Esc (at weight
 * `escape`, or on a progress view PROGRESS_ESCAPE once an outcome has shown); answers, deletion and
 * Unicode only while a text editor is open.
 */
export function menuKeys(escape: number) {
  return weighted([
    [30, typeFromSet(NAVIGATE)],
    [20, key(ENTER)],
    [escape, actions(() => (working() ? [] : [key(ESCAPE)]))],
    [PROGRESS_ESCAPE, actions(() => (hideable() ? [key(ESCAPE)] : []))],
    [4, key(" ")],
    [14, actions(() => (editing() ? [{ TypeText: { Regexp: ANSWER } }] : []))],
    [
      4,
      actions(() =>
        editing()
          ? [
              {
                TypeText: { CharSet: CharSet.fromLiterals("\u007F", "\u0015") },
              },
            ]
          : [],
      ),
    ],
    [3, actions(() => (editing() ? [{ TypeText: { CharSet: CharSets.UNICODE_SAFE } }] : []))],
  ]).when(menuOpen);
}

// The two sizes the contract names: the menu must fit 80x20 and use the room at 140x50.
export const resize = actions(() => [
  { Resize: { columns: 80, rows: 20 } },
  { Resize: { columns: 140, rows: 50 } },
]);

/**
 * Steers toward a consent row: Setup on the root, then, on any list showing one of CONSENT_ROWS
 * whose value does not say it is unready, toward that row and Enter. When none is visible it moves
 * up, which wraps to the last row (Apply on the fresh form). Elsewhere it leaves the fuzzer alone.
 */
export const towardApply = actions((): ActionTemplate[] => {
  const shown = screenNow();
  if (shown?.titleShown !== true) {
    return [];
  }
  if (shown.kind === "root") {
    return [key(shown.selected === "Setup" ? ENTER : DOWN)];
  }
  return shown.kind === "list" ? towardConsent(shown.rows, shown.selected) : [];
});

/** The first consent row whose value does not say it is unready, or undefined. */
function readyConsent(rows: readonly ListRow[]): string | undefined {
  return rows.find((row) => CONSENT_ROWS.has(row.label) && !NOT_READY.test(row.value))?.label;
}

/**
 * On a list: toward the ready consent row and Enter on it; nothing when only unready consent rows
 * show; Up (which wraps to the last row) when no consent row shows.
 */
function towardConsent(rows: readonly ListRow[], selected: string | null): ActionTemplate[] {
  const target = readyConsent(rows);
  if (target === undefined) {
    return rows.some((row) => CONSENT_ROWS.has(row.label)) ? [] : [key(UP)];
  }
  if (selected === target) {
    return [key(ENTER)];
  }
  const labels = rows.map((row) => row.label);
  return [key(labels.indexOf(target) < labels.indexOf(selected ?? "") ? UP : DOWN)];
}

/** Pi never exits or crashes: no key in the generators asks it to. */
export const piKeepsRunning: Formula = always(() => exitStatus.current === null);

// Sticky: whether the probe's footer row has been on screen yet. Pi draws nothing for its first
// second or so, so the probe can only be required once it has appeared.
let probeSeenOnce = false;
const probeSeen = extract((state: State) => {
  probeSeenOnce ||= readScreen(state).probe !== null;
  return probeSeenOnce;
});

/** Guard: the probe is loaded and reporting; without it the write properties would pass vacuously. */
export const probeAppears: Formula = eventually(() => probeSeen.current ?? false).within(
  20,
  "seconds",
);

/**
 * Once shown, the probe stays on screen. It is on the last footer row, so a menu too tall for the
 * terminal also pushes it off screen.
 */
export const probeShown: Formula = always(
  () => !(probeSeen.current ?? false) || (ui.current?.probe ?? null) !== null,
);

/** No /peers command writes under the agent directory or home except for a consented action. */
export const noUnreviewedWrite: Formula = always(
  () => !(ui.current?.probe ?? "").startsWith("probe:UNREVIEWED-WRITE"),
);

/** No /peers command changes or deletes an existing path except for a consented action. */
export const noUnreviewedChange: Formula = always(
  () => !(ui.current?.probe ?? "").startsWith("probe:UNREVIEWED-CHANGE"),
);

/**
 * Esc below the root goes back exactly one breadcrumb segment, the text editor included (its hint
 * is `Esc back`). Two contract exceptions: Esc on the outcome returns to the Peers root, and Esc on
 * progress hides the menu (or reaches the root when the outcome replaced it in the same step).
 */
export const escapeGoesBack: Formula = escapeLandsOn(
  () => ui.current,
  () => lastKey.current,
  (before) => {
    if (before.kind === null || before.path === null || before.depth === 0) {
      return undefined;
    }
    if (before.kind === "progress") {
      return [null, "Peers"];
    }
    return before.kind === "outcome" ? ["Peers"] : [before.path.slice(0, -1).join(" › ")];
  },
);

/** Esc at the Peers root closes the menu. */
export const escapeClosesRoot: Formula = escapeLandsOn(
  () => ui.current,
  () => lastKey.current,
  (before) => (before.kind === "root" ? [null] : undefined),
);

/** The hint says `Esc close` exactly at the root, and every hint has a known form. */
export const hintMatchesDepth: Formula = always(() => {
  const shown = screenNow();
  if (shown?.titleShown !== true || !shown.hintShown) {
    return true;
  }
  return shown.kind !== null && (shown.depth === 0) === (shown.esc === "close");
});

/** From 20 rows up, the open menu shows its title and the border directly below its hint. */
export const menuFits: Formula = fitsFrom(() => ui.current, 20);

/** List screens (root, lists, permissions) highlight exactly one row. */
export const oneSelected: Formula = oneHighlight(
  () => ui.current,
  (view) => view.kind === "root" || view.kind === "list" || view.kind === "toggle",
);

/** Report, progress and outcome views highlight nothing. */
export const noCursorInViews: Formula = always(() => {
  const view = ui.current;
  return (
    !(view?.kind === "report" || view?.kind === "progress" || view?.kind === "outcome") ||
    view.cursors === 0
  );
});

/**
 * Every outcome view, scrolled to its top, starts with a known headline (ok, pending or fail), and
 * its `Next:` row, if any, comes directly after the headline, before the fact rows.
 */
export const outcomeReadable: Formula = always(() => {
  const view = ui.current;
  if (view?.kind !== "outcome" || view.headline === null) {
    return true;
  }
  return view.outcome !== null && view.nextFollows !== false;
});

/** Reconnect and Reset outcomes sit under their own breadcrumb and report their own action. */
export const rootOutcomesMatch: Formula = always(() => {
  const view = ui.current;
  const expected = ROOT_OUTCOMES[view?.title ?? ""];
  return (
    view?.kind !== "outcome" ||
    view.headline === null ||
    expected === undefined ||
    expected.test(view.headline)
  );
});

/**
 * Every progress view ends, for Setup, Reconnect, Turn off and every Setup sub-action alike: its
 * outcome replaces it, or (after Esc hid the view) the action still reports, which the probe counts
 * as `reports:<n>` in the footer. A real gateway start fits comfortably in a minute.
 */
export const applyHasOutcome: Formula = always(() => {
  const view = ui.current;
  if (view?.kind !== "progress") {
    return true;
  }
  const before = view.reports ?? 0;
  return eventually(
    () => ui.current?.kind === "outcome" || (ui.current?.reports ?? 0) > before,
  ).within(60, "seconds");
});

/**
 * The footer agrees with the action: after Esc hides a progress view, the footer eventually leaves
 * `Peers: setting up…`; after any outcome view it is not stuck on `setting up…` either; and after
 * `✓ Peers set up` it shows `Peers: connected`.
 */
export const footerAgrees: Formula = always(() => {
  const view = ui.current;
  if (view?.kind === "progress") {
    return next(
      () =>
        lastKey.current !== ESCAPE ||
        menuOpen() ||
        eventually(() => ui.current?.footer !== SETTING_UP).within(60, "seconds"),
    );
  }
  if (view?.kind !== "outcome" || view.headline === null) {
    return true;
  }
  const connected = view.headline.startsWith("✓ Peers set up");
  return eventually(() =>
    connected ? ui.current?.footer === "Peers: connected" : ui.current?.footer !== SETTING_UP,
  ).within(10, "seconds");
});

// Vacuity guards. The menu is recognised by its title and hint text; if that text drifts from the
// contract, the menu properties would pass without checking anything, and these fail instead.

/** The fuzzer reaches the Peers root. */
export const rootReached: Formula = eventually(() => ui.current?.kind === "root").within(
  20,
  "seconds",
);

/** The fuzzer reaches a screen two levels deep (an editor, permissions or review). */
export const submenuReached: Formula = eventually(() => (ui.current?.depth ?? -1) >= 2).within(
  45,
  "seconds",
);

/** The fuzzer takes at least one Esc that goes back a level without closing the menu. */
export const backTaken: Formula = eventually(() => {
  const shown = screenNow();
  const depth = shown?.titleShown === true ? shown.depth : -1;
  return depth >= 1
    ? next(() => lastKey.current === ESCAPE && ui.current?.depth === depth - 1)
    : false;
}).within(60, "seconds");

/** The fuzzer reaches Apply's progress view or its outcome. */
export const applyReached: Formula = eventually(
  () => ui.current?.kind === "progress" || ui.current?.kind === "outcome",
).within(90, "seconds");

/** A recognised outcome headline is shown at least once. */
export const outcomeShown: Formula = eventually(
  () => (ui.current?.outcome ?? null) !== null,
).within(100, "seconds");
