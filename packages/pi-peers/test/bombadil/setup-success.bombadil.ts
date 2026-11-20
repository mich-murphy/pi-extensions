// Bombadil terminal specification for a /peers setup that succeeds (success suite), run against the
// real Pi CLI. Run with `npm run test:bombadil:peers:success`. setup-success.fixture.ts gives Pi
// canonical paths and the debug gateway; setup-success-extension.ts copies it in on Apply, so setup
// really starts a gateway and connects. A guided generator steers to Apply, then to `/peers status`
// and `/peers reset`; the rest is the same fuzzing and properties as the safety suite. The
// time-bounded guards sit inside the default 4m limit (see the end-of-run gap in setup-keys.ts).
import { always, eventually } from "@antithesishq/bombadil";
import type { Formula } from "@antithesishq/bombadil";
import { actions, extract, weighted } from "@antithesishq/bombadil/terminal";
import type { ActionTemplate, State } from "@antithesishq/bombadil/terminal";
import {
  command,
  commands,
  ENTER,
  ESCAPE,
  idle,
  key,
  menuKeys,
  readScreen,
  resize,
  towardApply,
  ui,
  UP,
} from "./setup-keys.ts";
import type { Screen } from "./setup-keys.ts";

export { noReplacementChars } from "@antithesishq/bombadil/terminal/defaults/properties";
export {
  applyHasOutcome,
  applyReached,
  backTaken,
  escapeClosesRoot,
  escapeGoesBack,
  footerAgrees,
  hintMatchesDepth,
  menuFits,
  noCursorInViews,
  noUnreviewedChange,
  noUnreviewedWrite,
  oneSelected,
  outcomeReadable,
  piKeepsRunning,
  probeAppears,
  probeShown,
  rootOutcomesMatch,
  rootReached,
} from "./setup-keys.ts";

// Reset's consent row and the action the seam reports for it.
const RESET_ROW = "Turn off peers";
const RESET_ACTION = "Disable";
const TURNED_OFF = "✓ Peers turned off";

type Facts = {
  succeeded: boolean;
  statusSeen: boolean;
  /** The probe's number for the last Disable consent, or 0 before any. */
  resetConsent: number;
  /** The last Disable consent after which a real reset effect was seen, or 0. */
  turnedOff: number;
};

// Sticky facts across the run. Updates only ever raise them, so evaluating a state twice is
// harmless.
const sticky: Facts = {
  succeeded: false,
  statusSeen: false,
  resetConsent: 0,
  turnedOff: 0,
};
/** Whether the screen shows setup's own success outcome. */
function setupSucceeded(screen: Screen): boolean {
  return screen.outcome === "ok" && (screen.headline ?? "").startsWith("✓ Peers set up");
}

/**
 * Whether peers is shown off after a reset: the reset's own outcome, or `/peers status` (or the
 * root's Status row) saying peers is off, with the footer no longer claiming a connection.
 */
function turnedOffShown(screen: Screen): boolean {
  return (
    (screen.headline ?? "").startsWith(TURNED_OFF) ||
    (screen.statusOff && screen.footer !== "Peers: connected")
  );
}

/** Raises the reset facts for a Disable consent on screen. */
function noteReset(screen: Screen): void {
  const consent = screen.consent;
  if (consent?.action !== RESET_ACTION) {
    return;
  }
  sticky.resetConsent = Math.max(sticky.resetConsent, consent.count);
  if (turnedOffShown(screen)) {
    sticky.turnedOff = Math.max(sticky.turnedOff, consent.count);
  }
}

const memory = extract((state: State): Facts => {
  const screen = readScreen(state);
  sticky.succeeded ||= setupSucceeded(screen);
  sticky.statusSeen ||= sticky.succeeded && screen.connectedShown;
  noteReset(screen);
  return { ...sticky };
});
/** The sticky facts, or undefined before Bombadil extracts the first state. */
const facts = (): Facts | undefined => memory.current;

/** The key that moves the cursor to `row` (Up wraps) or, once it is selected, chooses it. */
function choose(selected: string | null, row: string): ActionTemplate {
  return key(selected === row ? ENTER : UP);
}

/** The next key on an open menu after success: close the outcome, then reach and confirm Reset. */
function successMenuKey(view: Screen | undefined): ActionTemplate {
  if (view?.kind === "outcome") {
    return key(ENTER);
  }
  if (view?.kind === "root") {
    return choose(view.selected, "Reset");
  }
  return view?.kind === "list" && view.path?.[1] === "Reset"
    ? choose(view.selected, RESET_ROW)
    : key(ESCAPE);
}

/**
 * After success: close the outcome, run `/peers status`, then open bare `/peers` and reach Reset
 * from the root, so the root menu (rootReached) is always on this suite's path, and confirm it.
 */
const afterSuccess = actions((): ActionTemplate[] => {
  const seen = facts();
  if (seen?.succeeded !== true) {
    return [];
  }
  if (idle()) {
    return [command(seen.statusSeen ? "" : " status"), key(ENTER)];
  }
  return [successMenuKey(ui.current)];
});

export const successKeys = weighted([
  [6, commands({ bare: 3, setup: 3, status: 2, reset: 1, doctor: 1 })],
  [30, menuKeys(4)],
  [25, towardApply.when(() => facts()?.succeeded !== true)],
  [25, afterSuccess],
  [1, resize],
]);

/** Setup succeeds: the outcome row reads `✓ Peers set up — connected as …`. */
export const setupSucceeds: Formula = eventually(() => facts()?.succeeded === true).within(
  150,
  "seconds",
);

/** After success the footer shows `Peers: connected`. */
export const footerConnected: Formula = eventually(
  () => facts()?.succeeded === true && ui.current?.footer === "Peers: connected",
).within(160, "seconds");

/** After success, `/peers status` reports `Connected as …`. */
export const statusConnected: Formula = eventually(() => facts()?.statusSeen === true).within(
  200,
  "seconds",
);

/** After success, `/peers reset` reaches its confirm screen. */
export const resetReached: Formula = eventually(
  () => facts()?.succeeded === true && ui.current?.path?.[1] === "Reset",
).within(220, "seconds");

/**
 * Each `Turn off peers` consent really turns peers off: within 30 s the `✓ Peers turned off`
 * outcome appears, or status says `Peers is turned off` / `Not set up` with the footer no longer
 * `Peers: connected`.
 */
export const resetDisconnects: Formula = always(() => {
  const consent = facts()?.resetConsent ?? 0;
  return (
    consent === 0 || eventually(() => (facts()?.turnedOff ?? 0) >= consent).within(30, "seconds")
  );
});

/** Guard: the run consents to `Turn off peers` at least once, so resetDisconnects is not vacuous. */
export const resetConsented: Formula = eventually(() => (facts()?.resetConsent ?? 0) > 0).within(
  225,
  "seconds",
);
