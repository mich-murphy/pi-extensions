// Reads the /peers menu from trimmed screen rows, following the screen contract in the
// peers-setup-ux brief: breadcrumb title `Peers › A › B`, hint `<keys> · Esc back|close|hide` as the
// last content row, bottom border directly below it, `→ ` on the one selected list row, progress
// steps prefixed `✓ `/`… `/`· `, and the outcome headline as the first body row with any `Next:`
// row directly after it. Pure, so test/bombadil-menu.test.ts checks it against synthetic screens.
import { readMenu } from "../../../../test-support/bombadil-menu.ts";
import type { MenuView } from "../../../../test-support/bombadil-menu.ts";

const SHAPE = {
  title: /^Peers(?: › .+)?$/u,
  hint: /^(?<keys>.+) · Esc (?<esc>back|close|hide)$/u,
  separator: " › ",
};
const FOOTER = /Peers: (?:connected|setting up…|activation pending|unavailable|setup failed)/u;
// The report/outcome scroll indicator `(<first>–<last> of <total>)` and SettingsList's `(<i>/<n>)`.
const REPORT_SCROLL = /^\((?<first>\d+)–\d+ of \d+\)$/u;
const LIST_SCROLL = /^\(\d+\/\d+\)$/u;
// The probe's footer text: `probe:ok consent:<action>#<count> reports:<count>`.
const CONSENT = /\bconsent:(?<action>\S+)#(?<count>\d+)/u;
const REPORTS = /\breports:(?<count>\d+)/u;
// `/peers status` headlines (and the root's Status value) for a Pi with peers off.
const STATUS_OFF = /^(?:Peers is turned off|Peers is not set up)\b/u;
// An outcome fact row, `Machine: alpha`.
const FACT = /^[A-Z][A-Za-z ]{0,30}: /u;

export type OutcomeKind = "ok" | "pending" | "fail";

/**
 * Every outcome headline the menu shows as the first body row, by result. The same headline starts
 * the transcript's `peers-report` entry, so these also recognise a report outside the menu. Doctor
 * rows start with the same marks, so the list is explicit rather than any `✓`/`!`/`✗` row.
 */
export const HEADLINES: Readonly<Record<OutcomeKind, readonly string[]>> = {
  ok: [
    "✓ Peers set up — connected as",
    "✓ Settings changed — connected as",
    "✓ Peers turned off",
    "✓ Reconnected",
    "✓ Installation repaired",
    "✓ Saved configuration activated",
    "✓ Public bundle exported",
    "✓ Pairing ",
    "✓ New pair staged",
    "✓ Remote peer added",
  ],
  pending: ["! Settings saved — not active yet", "! Pairing ", "! Installation repaired"],
  fail: [
    "✗ Setup failed — ",
    "✗ Changing settings failed — ",
    "✗ Failed — ",
    "✗ Reconnect failed",
    "✗ Gateway state changed — review again",
    "✗ Reset refused — ",
    "✗ Reset partly done — ",
    "✗ Pairing ",
    "✗ Re-pair failed — ",
    "✗ Adding the peer failed — ",
    "✗ Repair failed — ",
    "✗ Not available here — ",
    "✗ Activation not confirmed",
  ],
};

/** The result an outcome headline reports, or null for a row that is no known headline. */
export function outcomeOf(text = ""): OutcomeKind | null {
  for (const result of ["ok", "pending", "fail"] as const) {
    if (HEADLINES[result].some((prefix) => text.startsWith(prefix))) {
      return result;
    }
  }
  return null;
}

export type PeersKind = "root" | "list" | "editor" | "toggle" | "report" | "progress" | "outcome";

/** The screen kind named by the hint's key text and Esc word, or null for an unknown hint. */
function kind(keys: string | undefined, esc: string | undefined): PeersKind | null {
  if (keys === undefined || esc === undefined) {
    return null;
  }
  if (esc === "hide") {
    return /^Working…$/u.test(keys) ? "progress" : null;
  }
  const word = /(?<word>select|save|toggle|scroll|close)$/u.exec(keys)?.groups?.word;
  const kinds: Record<string, PeersKind> = {
    select: esc === "close" ? "root" : "list",
    save: "editor",
    toggle: "toggle",
    scroll: "report",
    close: "outcome",
  };
  return word === undefined ? null : (kinds[word] ?? null);
}

/** One list row: its label and value (empty when the row shows none). */
export type ListRow = { label: string; value: string };

export type PeersView = MenuView & {
  kind: PeersKind | null;
  esc: "back" | "close" | "hide" | null;
  /** The list rows (root, lists, permissions); empty for other screens. */
  rows: ListRow[];
  /** The 1-based first line a report or outcome shows (1 when it is not scrolled). */
  scrollTop: number;
  /** The outcome headline row, when the outcome view is scrolled to its top. */
  headline: string | null;
  outcome: OutcomeKind | null;
  /**
   * Whether the first `Next:` row comes directly after the headline (a wrapped headline aside: no
   * `Label: value` fact row comes between them), or null without a headline or a `Next:` row.
   */
  nextFollows: boolean | null;
  /** The text editor's value (the `> ` row), or null when no editor is shown. */
  editorText: string | null;
  steps: { done: number; running: number; pending: number };
  /** Outcome headlines anywhere on screen: the menu's and the transcript's report entries. */
  reported: string[];
  /** `/peers status` (or the root's Status value) says peers is off. */
  statusOff: boolean;
  footer: string | null;
  probe: string | null;
  /** The last consent the probe saw, numbered from 1, or null before any. */
  consent: { action: string; count: number } | null;
  /** How many `peers-report` entries the probe saw, or null without the probe. */
  reports: number | null;
  height: number;
};

/**
 * A list body is an optional note, a blank row, then the list rows up to the next blank row (the
 * selected row's description follows it). SettingsList's scroll indicator is not a row.
 */
function listRows(body: readonly string[]): ListRow[] {
  const start = body.indexOf("");
  const rest = body.slice(start + 1);
  const end = rest.indexOf("");
  return (end === -1 ? rest : rest.slice(0, end))
    .filter((row) => !LIST_SCROLL.test(row))
    .map((row) => {
      const [label = "", ...value] = row.replace(/^→ /u, "").split(/\s{2,}/u);
      return { label, value: value.join("  ") };
    });
}

/** The report/outcome scroll position and the outcome headline, with its `Next:` placement. */
function outcomeFields(
  body: readonly string[],
  shown: PeersKind | null,
): Pick<PeersView, "scrollTop" | "headline" | "outcome" | "nextFollows"> {
  const lines = body.filter((row) => row !== "");
  const scroll = REPORT_SCROLL.exec(lines.at(-1) ?? "")?.groups?.first;
  const scrollTop = scroll === undefined ? 1 : Number(scroll);
  const headline = shown === "outcome" && scrollTop === 1 ? (lines[0] ?? null) : null;
  return {
    scrollTop,
    headline,
    outcome: headline === null ? null : outcomeOf(headline),
    nextFollows: headline === null ? null : nextFollows(lines),
  };
}

/** Whether no fact row comes between the headline (`lines[0]`) and the first `Next:` row. */
function nextFollows(lines: readonly string[]): boolean | null {
  const next = lines.findIndex((row) => row.startsWith("Next:"));
  return next < 0 ? null : !lines.slice(1, next).some((row) => FACT.test(row));
}

/** The progress view's step counts by mark; all zero on any other screen. */
function stepCounts(body: readonly string[], shown: PeersKind | null): PeersView["steps"] {
  const count = (mark: string): number =>
    shown === "progress" ? body.filter((row) => row.startsWith(`${mark} `)).length : 0;
  return { done: count("✓"), running: count("…"), pending: count("·") };
}

/** The text editor's `> ` row value, or null when no editor is shown. */
function editorValue(body: readonly string[], shown: PeersKind | null): string | null {
  const editor = shown === "editor" ? body.find((row) => /^>(?: |$)/u.test(row)) : undefined;
  return editor === undefined ? null : editor.slice(1).trim();
}

/** The probe's footer row and its consent and report counters. */
function probeFields(rows: readonly string[]): Pick<PeersView, "probe" | "consent" | "reports"> {
  const probe = rows.find((row) => row.startsWith("probe:")) ?? null;
  const consent = CONSENT.exec(probe ?? "")?.groups;
  const reports = REPORTS.exec(probe ?? "")?.groups?.count;
  return {
    probe,
    consent:
      consent?.action === undefined
        ? null
        : { action: consent.action, count: Number(consent.count) },
    reports: reports === undefined ? null : Number(reports),
  };
}

/** Whether `/peers status` or the root's Status row says peers is off. */
function statusOffShown(
  rows: readonly string[],
  shown: PeersKind | null,
  list: readonly ListRow[],
): boolean {
  const rootOff =
    shown === "root" && list.some((row) => row.label === "Status" && row.value === "Not set up");
  return rootOff || rows.some((row) => STATUS_OFF.test(row));
}

/** The list rows of a root, list or toggle screen; empty for other screens. */
function shownRows(body: readonly string[], shown: PeersKind | null): ListRow[] {
  return shown === "root" || shown === "list" || shown === "toggle" ? listRows(body) : [];
}

/** The Esc word of a known hint, or null. */
function escWord(esc: string | undefined): PeersView["esc"] {
  return esc === "back" || esc === "close" || esc === "hide" ? esc : null;
}

/** The first footer status on screen, or null. */
function footerOf(rows: readonly string[]): string | null {
  return rows.map((row) => FOOTER.exec(row)?.[0]).find((found) => found !== undefined) ?? null;
}

/** The /peers menu, footer status and probe status on screen. */
export function readPeers(rows: readonly string[], height: number): PeersView {
  const menu = readMenu(rows, SHAPE);
  const { keys, esc } = menu.hintGroups;
  const shown = kind(keys, esc);
  const list = shownRows(menu.body, shown);
  return {
    ...menu,
    kind: shown,
    esc: escWord(esc),
    rows: list,
    ...outcomeFields(menu.body, shown),
    editorText: editorValue(menu.body, shown),
    steps: stepCounts(menu.body, shown),
    reported: rows.filter((row) => outcomeOf(row) !== null),
    statusOff: statusOffShown(rows, shown, list),
    footer: footerOf(rows),
    ...probeFields(rows),
    height,
  };
}
