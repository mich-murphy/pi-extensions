import { readMenu } from "../../../../test-support/bombadil-menu.ts";
import type { MenuView } from "../../../../test-support/bombadil-menu.ts";

const SHAPE = {
  title: /^Peers(?: › .+)?$/u,
  hint: /^(?<keys>.+) · Esc (?<esc>back|close|hide)$/u,
  separator: " › ",
};
const FOOTER =
  /peers (?:✓(?: waiting…)?|● \d+|⋯ setting up|! activation pending|✕ (?:offline|setup failed))(?: ! (?:\S+|\d+ links) down)?/u;
const REPORT_SCROLL = /^\((?<first>\d+)–\d+ of \d+\)$/u;
const LIST_SCROLL = /^\(\d+\/\d+\)$/u;
const CONSENT = /\bconsent:(?<action>\S+)#(?<count>\d+)/u;
const REPORTS = /\breports:(?<count>\d+)/u;
const STATUS_OFF = /^(?:Peers is turned off|Peers is not set up)\b/u;
const FACT = /^[A-Z][A-Za-z ]{0,30}: /u;

export type OutcomeKind = "ok" | "pending" | "fail";

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
  pending: ["! Settings saved but not active yet", "! Pairing ", "! Installation repaired"],
  fail: [
    "✗ Setup failed: ",
    "✗ Changing settings failed: ",
    "✗ Failed: ",
    "✗ Reconnect failed: ",
    "✗ Reset failed: ",
    "✗ Pairing ",
    "✗ Re-pair failed: ",
    "✗ Adding the peer failed: ",
    "✗ Repair failed: ",
    "✗ Not available here: ",
    "✗ Activation failed: ",
  ],
};

export function outcomeOf(text = ""): OutcomeKind | null {
  for (const result of ["ok", "pending", "fail"] as const) {
    if (HEADLINES[result].some((prefix) => text.startsWith(prefix))) {
      return result;
    }
  }
  return null;
}

export type PeersKind = "root" | "list" | "editor" | "toggle" | "report" | "progress" | "outcome";

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

export type ListRow = { label: string; value: string };

export type PeersView = MenuView & {
  kind: PeersKind | null;
  esc: "back" | "close" | "hide" | null;
  rows: ListRow[];
  scrollTop: number;
  headline: string | null;
  outcome: OutcomeKind | null;
  nextFollows: boolean | null;
  editorText: string | null;
  steps: { done: number; running: number; pending: number };
  reported: string[];
  statusOff: boolean;
  footer: string | null;
  probe: string | null;
  consent: { action: string; count: number } | null;
  reports: number | null;
  height: number;
};

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

function nextFollows(lines: readonly string[]): boolean | null {
  const next = lines.findIndex((row) => row.startsWith("Next:"));
  return next < 0 ? null : !lines.slice(1, next).some((row) => FACT.test(row));
}

function stepCounts(body: readonly string[], shown: PeersKind | null): PeersView["steps"] {
  const count = (mark: string): number =>
    shown === "progress" ? body.filter((row) => row.startsWith(`${mark} `)).length : 0;
  return { done: count("✓"), running: count("…"), pending: count("·") };
}

function editorValue(body: readonly string[], shown: PeersKind | null): string | null {
  const editor = shown === "editor" ? body.find((row) => /^>(?: |$)/u.test(row)) : undefined;
  return editor === undefined ? null : editor.slice(1).trim();
}

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

function statusOffShown(
  rows: readonly string[],
  shown: PeersKind | null,
  list: readonly ListRow[],
): boolean {
  const rootOff =
    shown === "root" && list.some((row) => row.label === "Status" && row.value === "Not set up");
  return rootOff || rows.some((row) => STATUS_OFF.test(row));
}

function shownRows(body: readonly string[], shown: PeersKind | null): ListRow[] {
  return shown === "root" || shown === "list" || shown === "toggle" ? listRows(body) : [];
}

function escWord(esc: string | undefined): PeersView["esc"] {
  return esc === "back" || esc === "close" || esc === "hide" ? esc : null;
}

function footerOf(rows: readonly string[]): string | null {
  return rows.map((row) => FOOTER.exec(row)?.[0]).find((found) => found !== undefined) ?? null;
}

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
