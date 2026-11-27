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
const SETTING_UP = "peers ⋯ setting up";
const CONNECTED = "peers ✓";

const CONSENT_ROWS = new Set([
  "Apply",
  "Restart and activate",
  "Repair installation",
  "Add peer",
  "Import bundle",
  "Turn off peers",
]);

const NOT_READY = /^(?:No changes|Missing: |Invalid: |Blocked: )/u;

const ROOT_OUTCOMES = new Map([
  ["Peers › Reconnect › Result", /^(?:✓ Reconnected — |✗ Reconnect failed: |✗ Failed: )/u],
  ["Peers › Reset › Result", /^(?:✓ Peers turned off|✗ Reset failed: |✗ Failed: )/u],
]);

export type Screen = PeersView & {
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
const screenNow = (): Screen | undefined => ui.current;
const exitStatus = extract((state: State) => state.exitStatus);
export const lastKey = extract((state: State) => typedText(state));

export const menuOpen = (): boolean =>
  screenNow()?.titleShown === true || screenNow()?.hintShown === true;

export const idle = (): boolean => !menuOpen();
const editing = (): boolean => ui.current?.kind === "editor";
const working = (): boolean => ui.current?.kind === "progress";
let outcomeSeenOnce = false;

const outcomeSeen = extract((state: State) => {
  outcomeSeenOnce ||= readScreen(state).outcome !== null;

  return outcomeSeenOnce;
});

const PROGRESS_ESCAPE = 3;
const hideable = (): boolean => working() && (outcomeSeen.current ?? false);

export const key = (text: string): ActionTemplate => ({
  TypeText: { CharSet: CharSet.fromLiterals(text) },
});

export const command = (suffix: string): ActionTemplate => ({
  TypeText: { Regexp: `${String.raw`\x15/peers`}${suffix}` },
});

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

const ANSWER = String.raw`127\.0\.0\.1:[0-9]{1,5}|\[::1\]:[0-9]{2,5}|[a-z][a-z0-9-]{0,12}|/[a-z]{1,8}(/[a-z.]{1,8}){0,2}|[0-9a-f]{64}|[A-Za-z ]{0,20}`;
const NAVIGATE = CharSet.fromLiterals(UP, DOWN, "j", "k", "\u001B[5~", "\u001B[6~");

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

export const resize = actions(() => [
  { Resize: { columns: 80, rows: 20 } },
  { Resize: { columns: 140, rows: 50 } },
]);

export const towardApply = actions((): Array<ActionTemplate> => {
  const shown = screenNow();

  if (shown?.titleShown !== true) {
    return [];
  }

  if (shown.kind === "root") {
    return [key(shown.selected === "Setup" ? ENTER : DOWN)];
  }

  return shown.kind === "list" ? towardConsent(shown.rows, shown.selected) : [];
});

function readyConsent(rows: ReadonlyArray<ListRow>): string | undefined {
  return rows.find((row) => CONSENT_ROWS.has(row.label) && !NOT_READY.test(row.value))?.label;
}

function towardConsent(
  rows: ReadonlyArray<ListRow>,
  selected: string | null,
): Array<ActionTemplate> {
  const target = readyConsent(rows);

  if (target !== undefined) {
    return [stepToward(rows, selected, target)];
  }

  if (rows.some((row) => row.label === MODE && row.value === REMOTE_MODE)) {
    return [stepToward(rows, selected, MODE)];
  }

  return rows.some((row) => CONSENT_ROWS.has(row.label)) ? [] : [key(UP)];
}

const MODE = "Mode";
const REMOTE_MODE = "One remote peer";

function stepToward(
  rows: ReadonlyArray<ListRow>,
  selected: string | null,
  target: string,
): ActionTemplate {
  if (selected === target) {
    return key(ENTER);
  }

  const labels = rows.map((row) => row.label);

  return key(labels.indexOf(target) < labels.indexOf(selected ?? "") ? UP : DOWN);
}

export const piKeepsRunning: Formula = always(() => exitStatus.current === null);

let probeSeenOnce = false;

const probeSeen = extract((state: State) => {
  probeSeenOnce ||= readScreen(state).probe !== null;

  return probeSeenOnce;
});

export const probeAppears: Formula = eventually(() => probeSeen.current ?? false).within(
  20,
  "seconds",
);

export const probeShown: Formula = always(
  () => !(probeSeen.current ?? false) || (ui.current?.probe ?? null) !== null,
);

export const noUnreviewedWrite: Formula = always(
  () => !(ui.current?.probe ?? "").startsWith("probe:UNREVIEWED-WRITE"),
);

export const noUnreviewedChange: Formula = always(
  () => !(ui.current?.probe ?? "").startsWith("probe:UNREVIEWED-CHANGE"),
);

const LOADING = "Checking…";

const COMMAND_OPENS_ITS_SCREEN_WHEN_LOADING_ENDS_AFTER_ESCAPE_REACHES_ROOT = [
  "Peers",
  "Peers › Setup",
  "Peers › Reset",
];

function backFrom(before: Screen): ReadonlyArray<string | null> | undefined {
  if (before.kind === null || before.path === null || before.depth === 0) {
    return undefined;
  }

  if (before.kind === "progress") {
    return [null, "Peers"];
  }

  return before.kind === "outcome" ? ["Peers"] : [before.path.slice(0, -1).join(" › ")];
}

const loadingReport = (before: Screen): boolean =>
  before.depth === 1 && before.body.some((row) => row.trim() === LOADING);

export const escapeGoesBack: Formula = escapeLandsOn(
  () => ui.current,
  () => lastKey.current,
  (before) =>
    loadingReport(before)
      ? COMMAND_OPENS_ITS_SCREEN_WHEN_LOADING_ENDS_AFTER_ESCAPE_REACHES_ROOT
      : backFrom(before),
);

const SETUP_COMMAND_OPENS_SETUP_WHEN_LOADING_ENDS_SO_ESCAPE_MAY_GO_BACK_TO_ROOT = [null, "Peers"];

export const escapeClosesRoot: Formula = escapeLandsOn(
  () => ui.current,
  () => lastKey.current,
  (before) => {
    if (before.kind !== "root") {
      return undefined;
    }

    return before.rows.some((row) => row.value === LOADING)
      ? SETUP_COMMAND_OPENS_SETUP_WHEN_LOADING_ENDS_SO_ESCAPE_MAY_GO_BACK_TO_ROOT
      : [null];
  },
);

export const hintMatchesDepth: Formula = always(() => {
  const shown = screenNow();

  if (shown?.titleShown !== true || !shown.hintShown) {
    return true;
  }

  return shown.kind !== null && (shown.depth === 0) === (shown.esc === "close");
});

export const menuFits: Formula = fitsFrom(() => ui.current, 20);

export const oneSelected: Formula = oneHighlight(
  () => ui.current,
  (view) => view.kind === "root" || view.kind === "list" || view.kind === "toggle",
);

export const noCursorInViews: Formula = always(() => {
  const view = ui.current;

  return (
    !(view?.kind === "report" || view?.kind === "progress" || view?.kind === "outcome") ||
    view.cursors === 0
  );
});

export const outcomeReadable: Formula = always(() => {
  const view = ui.current;

  if (view?.kind !== "outcome" || view.headline === null) {
    return true;
  }

  return view.outcome !== null && view.nextFollows !== false;
});

export const rootOutcomesMatch: Formula = always(() => {
  const view = ui.current;
  const expected = ROOT_OUTCOMES.get(view?.title ?? "");

  return (
    view?.kind !== "outcome" ||
    view.headline === null ||
    expected === undefined ||
    expected.test(view.headline)
  );
});

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
    connected ? ui.current?.footer === CONNECTED : ui.current?.footer !== SETTING_UP,
  ).within(10, "seconds");
});

export const rootReached: Formula = eventually(() => ui.current?.kind === "root").within(
  20,
  "seconds",
);

export const submenuReached: Formula = eventually(() => (ui.current?.depth ?? -1) >= 2).within(
  45,
  "seconds",
);

export const backTaken: Formula = eventually(() => {
  const shown = screenNow();
  const depth = shown?.titleShown === true ? shown.depth : -1;

  return depth >= 1
    ? next(() => lastKey.current === ESCAPE && ui.current?.depth === depth - 1)
    : false;
}).within(60, "seconds");

export const applyReached: Formula = eventually(
  () => ui.current?.kind === "progress" || ui.current?.kind === "outcome",
).within(90, "seconds");

export const outcomeShown: Formula = eventually(
  () => (ui.current?.outcome ?? null) !== null,
).within(100, "seconds");
