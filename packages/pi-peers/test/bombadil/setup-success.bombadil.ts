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

const RESET_ROW = "Turn off peers";
const RESET_ACTION = "Disable";
const TURNED_OFF = "✓ Peers turned off";

type Facts = {
  succeeded: boolean;
  statusSeen: boolean;
  resetConsent: number;
  turnedOff: number;
};

const sticky: Facts = {
  succeeded: false,
  statusSeen: false,
  resetConsent: 0,
  turnedOff: 0,
};
function setupSucceeded(screen: Screen): boolean {
  return screen.outcome === "ok" && (screen.headline ?? "").startsWith("✓ Peers set up");
}

function turnedOffShown(screen: Screen): boolean {
  return (
    (screen.headline ?? "").startsWith(TURNED_OFF) ||
    (screen.statusOff && screen.footer !== "peers ✓")
  );
}

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
const facts = (): Facts | undefined => memory.current;

function choose(selected: string | null, row: string): ActionTemplate {
  return key(selected === row ? ENTER : UP);
}

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

export const setupSucceeds: Formula = eventually(() => facts()?.succeeded === true).within(
  150,
  "seconds",
);

export const footerConnected: Formula = eventually(
  () => facts()?.succeeded === true && ui.current?.footer === "peers ✓",
).within(160, "seconds");

export const statusConnected: Formula = eventually(() => facts()?.statusSeen === true).within(
  200,
  "seconds",
);

export const resetReached: Formula = eventually(
  () => facts()?.succeeded === true && ui.current?.path?.[1] === "Reset",
).within(220, "seconds");

export const resetDisconnects: Formula = always(() => {
  const consent = facts()?.resetConsent ?? 0;
  return (
    consent === 0 || eventually(() => (facts()?.turnedOff ?? 0) >= consent).within(30, "seconds")
  );
});

export const resetConsented: Formula = eventually(() => (facts()?.resetConsent ?? 0) > 0).within(
  225,
  "seconds",
);
