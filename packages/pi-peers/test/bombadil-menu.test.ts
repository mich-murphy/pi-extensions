import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { bottomBorderBelow, readMenu } from "../../../test-support/bombadil-menu.ts";
import { outcomeOf, readPeers } from "./bombadil/peers-screen.ts";

const RULE = "─".repeat(80);
const CHROME = [RULE, ">", RULE, "~/cwd", "0.0%/200k (auto)", "probe:ok peers ⋯ setting up"];

function screen(menu: readonly string[]): string[] {
  const rows = ["Welcome", RULE, ...menu, RULE, ...CHROME];
  return [...rows, ...Array.from({ length: Math.max(0, 20 - rows.length) }, () => "")];
}

describe("readPeers", () => {
  test("reads the root list", () => {
    const view = readPeers(
      screen([
        "Peers",
        "",
        "→ Status     Not set up",
        "Setup      Set up",
        "Doctor",
        "",
        "Show whether peers is connected → details",
        "Enter select · Esc close",
      ]),
      20,
    );
    expect(view).toMatchObject({
      kind: "root",
      esc: "close",
      depth: 0,
      cursors: 1,
      selected: "Status",
      bottomShown: true,
      footer: "peers ⋯ setting up",
      probe: "probe:ok peers ⋯ setting up",
    });
  });

  test("reads a nested list, an editor and a toggle list", () => {
    const setup = readPeers(
      screen([
        "Peers › Setup",
        "Nothing changes until you choose Apply.",
        "→ Mode  Local only",
        "Enter select · Esc back",
      ]),
      20,
    );
    expect(setup).toMatchObject({
      kind: "list",
      path: ["Peers", "Setup"],
      depth: 1,
    });
    const editor = readPeers(
      screen(["Peers › Setup › Label", "> alpha", "Enter save · Esc back"]),
      20,
    );
    expect(editor).toMatchObject({
      kind: "editor",
      depth: 2,
      editorText: "alpha",
      cursors: 0,
    });
    const empty = readPeers(screen(["Peers › Setup › Label", ">", "Enter save · Esc back"]), 20);
    expect(empty.editorText).toBe("");
    const toggle = readPeers(
      screen(["Peers › Setup › Permissions", "→ read  On", "Enter toggle · Esc back"]),
      20,
    );
    expect(toggle.kind).toBe("toggle");
  });

  test("reads progress and both outcomes", () => {
    const progress = readPeers(
      screen([
        "Peers › Setup › Applying",
        "✓ Check plan",
        "… Download gateway (2s)",
        "· Start gateway",
        "Working… · Esc hide",
      ]),
      20,
    );
    expect(progress).toMatchObject({
      kind: "progress",
      esc: "hide",
      cursors: 0,
      outcome: null,
    });
    expect(progress.steps).toStrictEqual({ done: 1, running: 1, pending: 1 });
    const ok = readPeers(
      screen([
        "Peers › Setup › Result",
        "✓ Peers set up — connected as alpha",
        "Machine  alpha",
        "Enter close · Esc back",
      ]),
      20,
    );
    expect(ok).toMatchObject({ kind: "outcome", outcome: "ok", depth: 2 });
    const fail = readPeers(
      screen([
        "Peers › Setup › Result",
        "✗ Setup failed: unexpected error",
        "Enter close · Esc back",
      ]),
      20,
    );
    expect(fail.outcome).toBe("fail");
  });

  test("ignores cursors and hints outside the menu, and finds no menu when closed", () => {
    const rows = screen(["Peers", "→ Status  Connected", "Enter select · Esc close"]);
    rows[0] = "→ chat text with a cursor";
    expect(readPeers(rows, 20).cursors).toBe(1);
    const closed = readPeers(["Notes · Esc back", "probe:ok", ...CHROME], 20);
    expect(closed).toMatchObject({
      title: null,
      depth: -1,
      cursors: 0,
      kind: null,
    });
    expect(closed.titleShown).toBe(false);
  });

  test("reports a cut-off bottom border", () => {
    const rows = ["Peers", "→ Status", "Enter select · Esc close", ">"];
    expect(readPeers(rows, 4).bottomShown).toBe(false);
    expect(bottomBorderBelow(rows, -1)).toBe(false);
  });
});

describe("outcomes and the probe", () => {
  test("outcomeOf recognises every headline by result", () => {
    const cases: [string, "ok" | "pending" | "fail" | null][] = [
      ["✓ Peers set up — connected as alpha", "ok"],
      ["✓ Settings changed — connected as alpha", "ok"],
      ["✓ Peers turned off", "ok"],
      ["✓ Reconnected — Connected as alpha", "ok"],
      ["✗ Reconnect failed: peers is unavailable right now", "fail"],
      ["! Settings saved but not active yet", "pending"],
      ["✗ Changing settings failed: the gateway started or stopped since you reviewed", "fail"],
      ["✗ Setup failed: no verified gateway download for this platform", "fail"],
      ["✗ Reset failed: pi-peers.json was edited by hand", "fail"],
      ["✗ Failed: unexpected error", "fail"],
      ["✓ Config file: ok", null],
      ["Machine: alpha", null],
    ];
    for (const [row, expected] of cases) {
      expect({ row, result: outcomeOf(row) }).toStrictEqual({ row, result: expected });
    }
  });

  test("reads a root-action outcome, its Next row and a pending outcome", () => {
    const reset = readPeers(
      screen([
        "Peers › Reset › Result",
        "",
        "✓ Peers turned off",
        "Next: Other open Pi sessions stay connected until they close.",
        "Saved copy: /x/pi-peers.json.disabled-1",
        "",
        "Enter close · Esc back",
      ]),
      20,
    );
    expect(reset).toMatchObject({
      kind: "outcome",
      outcome: "ok",
      headline: "✓ Peers turned off",
      nextFollows: true,
    });
    const late = readPeers(
      screen([
        "Peers › Setup › Result",
        "! Settings saved but not active yet",
        "Machine: alpha",
        "Next: Choose Reconnect.",
        "Enter close · Esc back",
      ]),
      20,
    );
    expect(late).toMatchObject({ outcome: "pending", nextFollows: false });
    const scrolled = readPeers(
      screen(["Peers › Setup › Result", "Gateway: x", "(3–4 of 9)", "Enter close · Esc back"]),
      20,
    );
    expect(scrolled).toMatchObject({
      scrollTop: 3,
      headline: null,
      outcome: null,
    });
  });

  test("reads list rows with values, the probe counters and status off", () => {
    const rows = screen([
      "Peers › Setup",
      "Nothing changes until you choose Apply.",
      "",
      "Mode            Local only",
      "Review details",
      "→ Apply         No changes",
      "",
      "Change a setting above first.",
      "Enter select · Esc back",
    ]);
    rows[rows.findIndex((row) => row.startsWith("probe:"))] =
      "probe:ok consent:Disable#3 reports:2";
    rows[1] = "Peers is turned off";
    const view = readPeers(rows, 20);
    expect(view.rows).toStrictEqual([
      { label: "Mode", value: "Local only" },
      { label: "Review details", value: "" },
      { label: "Apply", value: "No changes" },
    ]);
    expect(view).toMatchObject({
      selected: "Apply",
      consent: { action: "Disable", count: 3 },
      reports: 2,
      statusOff: true,
    });
    expect(
      readPeers(screen(["Peers", "→ Status  Connected", "Enter select · Esc close"]), 20),
    ).toMatchObject({ consent: null, reports: null, statusOff: false });
  });
});

describe("readMenu", () => {
  test("takes the first hint below the title", () => {
    const view = readMenu(["Enter x · Esc back", "Title", "→ a  1", "Enter x · Esc back", RULE], {
      title: /^Title$/u,
      hint: /^Enter x · Esc (?<esc>back)$/u,
      separator: " › ",
    });
    expect(view).toMatchObject({
      body: ["→ a  1"],
      hintGroups: { esc: "back" },
      bottomShown: true,
    });
  });
});

const SUITES = {
  "test:bombadil:peers:setup": ["setup.bombadil.ts", "setup-keys.ts"],
  "test:bombadil:peers:success": ["setup-success.bombadil.ts", "setup-keys.ts"],
  "test:bombadil:peers:messages": ["peers.bombadil.ts"],
} as const;

function npmScript(name: string): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  const scripts: unknown =
    typeof manifest === "object" && manifest !== null && "scripts" in manifest
      ? manifest.scripts
      : undefined;
  const script: unknown =
    typeof scripts === "object" && scripts !== null && name in scripts
      ? Reflect.get(scripts, name)
      : undefined;
  if (typeof script !== "string") {
    throw new TypeError(`No npm script ${name}`);
  }
  return script;
}

function defaultLimitSeconds(name: string): number {
  const match = /BOMBADIL_TIME_LIMIT:-(?<amount>\d+)(?<unit>m|s)\}/u.exec(npmScript(name));
  if (match?.groups === undefined) {
    throw new Error(`No default time limit for ${name}`);
  }
  return Number(match.groups.amount) * (match.groups.unit === "m" ? 60 : 1);
}

function guardSeconds(file: string): number[] {
  const source = readFileSync(new URL(`bombadil/${file}`, import.meta.url), "utf8");
  return [...source.matchAll(/\.within\(\s*(?<seconds>\d+),\s*"seconds"/gu)].map((match) =>
    Number(match.groups?.seconds),
  );
}

describe("Bombadil suite time limits", () => {
  test.each(Object.entries(SUITES))(
    "%s: Bombadil passes obligations still open at its time limit, so every guard sits inside it",
    (name, files) => {
      const guards = files.flatMap((file) => guardSeconds(file));
      expect(guards.length).toBeGreaterThan(0);
      expect(Math.max(...guards)).toBeLessThan(defaultLimitSeconds(name));
    },
  );
});
