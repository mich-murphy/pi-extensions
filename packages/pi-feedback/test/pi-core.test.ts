import { describe, expect, test } from "vitest";
import { isParallelBatch, isReadOnlyTool } from "../batch.ts";
import type { BatchCall } from "../batch.ts";
import { signalFingerprint } from "../fingerprint.ts";
import type { LedgerEvent, VerdictEvent } from "../ledger.ts";
import { createAttribution } from "../owner.ts";
import type { ToolSource } from "../owner.ts";
import { deriveGroups } from "../queue.ts";

const PACKAGES = "/repo/packages";
const HOME = "/home/u";
const SCRATCH = "/tmp/claude-1/-home-u-dev-x/0a1b/scratchpad";

const tools: readonly ToolSource[] = [
  { name: "read", sourceInfo: { path: "builtin:read", source: "builtin" } },
  { name: "bash", sourceInfo: { path: "builtin:bash", source: "builtin" } },
  { name: "edit", sourceInfo: { path: "builtin:edit", source: "builtin" } },
  { name: "codemode", sourceInfo: { path: "/elsewhere/codemode/index.ts", source: "local" } },
  { name: "webfetch", sourceInfo: { path: `${PACKAGES}/pi-web/index.ts`, source: "local" } },
  {
    name: "pi_claude_sdk_validation_error",
    sourceInfo: { path: `${PACKAGES}/pi-claude/index.ts`, source: "local" },
  },
];

const owners = createAttribution(
  { getAllTools: () => tools, getCommands: () => [] },
  {
    packagesDir: PACKAGES,
    ownPackages: ["pi-claude", "pi-web", "pi-skills"],
    agentDir: `${HOME}/.pi/agent`,
    home: HOME,
  },
);

const readOnly = (name: string): boolean =>
  isReadOnlyTool(tools.find((tool) => tool.name === name));

type Scores = Pick<VerdictEvent, "harnessPath" | "pathExisted" | "outsideService">;

type Fixture = {
  readonly label: string;
  readonly piCore: boolean;
  readonly tool: string;
  readonly error: string;
  readonly scores: Scores;
  readonly siblings?: readonly BatchCall[];
  readonly args?: BatchCall["args"];
};

const harnessLike: Scores = { harnessPath: 0.9, pathExisted: 0.9, outsideService: 0.02 };

const FIXTURES: readonly Fixture[] = [
  {
    label: "pi-claude rejected tool call",
    piCore: false,
    tool: "pi_claude_sdk_validation_error",
    error: "The SDK tried to call an undeclared tool.",
    scores: { harnessPath: 0.05, pathExisted: 0.1, outsideService: 0.05 },
  },
  {
    label: "pi-claude long scratch socket path",
    piCore: false,
    tool: "bash",
    error: `error connecting to ${SCRATCH}/tmux.sock (File name too long)`,
    scores: harnessLike,
  },
  {
    label: "pi-claude scratchpad from an earlier turn",
    piCore: false,
    tool: "codemode",
    error: `Script error: ENOENT: no such file or directory, access '${SCRATCH}/a.json'`,
    scores: harnessLike,
  },
  {
    label: "Claude project directory name read as an option",
    piCore: false,
    tool: "bash",
    error: "find: unknown predicate `-home-u-dev-x'",
    scores: { harnessPath: 0.2, pathExisted: 0.8, outsideService: 0.03 },
  },
  {
    label: "unrelated git output scored as harness",
    piCore: false,
    tool: "bash",
    error: "a0ba8762 e1285884 DESIGN.md | 1 + README.md | 7 ++++++-",
    scores: { harnessPath: 0.83, pathExisted: 0.9, outsideService: 0.02 },
  },
  {
    label: "project build failure",
    piCore: false,
    tool: "bash",
    error: "make: *** [all] Error 2",
    scores: { harnessPath: 0.1, pathExisted: 0.5, outsideService: 0.05 },
  },
  {
    label: "edit text mismatch",
    piCore: false,
    tool: "edit",
    error: "Could not find the exact text in /home/u/dev/x/a.ts.",
    scores: { harnessPath: 0.09, pathExisted: 0.9, outsideService: 0.03 },
  },
  {
    label: "command timeout",
    piCore: false,
    tool: "bash",
    error: "Command timed out after 60 seconds",
    scores: { harnessPath: 0.4, pathExisted: 0.5, outsideService: 0.07 },
  },
  {
    label: "outside web page missing",
    piCore: false,
    tool: "webfetch",
    error: "Request failed (404 Not Found).",
    scores: { harnessPath: 0.03, pathExisted: 0.1, outsideService: 0.97 },
  },
  {
    label: "read of a file a sibling call was still writing",
    piCore: false,
    tool: "read",
    error: `ENOENT: no such file or directory, access '${SCRATCH}/z5.png'`,
    args: { path: `${SCRATCH}/z5.png` },
    siblings: [
      { id: "s1", name: "bash", args: { command: `S=${SCRATCH}; sips x --out $S/z5.png` } },
    ],
    scores: harnessLike,
  },
  {
    label: "Pi session directory name read as an option",
    piCore: true,
    tool: "bash",
    error: "ls: unrecognized option '--home-u-dev-x--'",
    scores: { harnessPath: 0.86, pathExisted: 0.9, outsideService: 0.03 },
  },
];

function stamp(n: number) {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    at: new Date(Date.UTC(2026, 10, 25, 0, 0, 0, n)).toISOString(),
  };
}

function eventsFor(fixture: Fixture, start: number): LedgerEvent[] {
  const fingerprint = signalFingerprint(fixture.tool, fixture.error);
  const attribution = owners.forSignal(fixture.tool, fixture.error);
  const failing: BatchCall = { id: "f1", name: fixture.tool, args: fixture.args ?? {} };
  const ordered = isParallelBatch(
    failing,
    fixture.error,
    [failing, ...(fixture.siblings ?? [])],
    readOnly,
  );
  const signals = ["a", "b", "c"].map((session, index): LedgerEvent => ({
    type: "signal",
    ...stamp(start + index),
    session,
    owner: attribution.owner,
    fingerprint,
    tool: fixture.tool,
    error: fixture.error,
    ...(ordered ? { cause: "parallel-batch" as const } : {}),
    ...(attribution.evidence === undefined ? {} : { evidence: attribution.evidence }),
  }));
  const verdict: LedgerEvent = {
    type: "verdict",
    ...stamp(start + 3),
    fingerprint,
    model: "typesafe/jev-1.14.0",
    ...fixture.scores,
  };
  return [...signals, verdict];
}

describe("Pi core label", () => {
  const events = FIXTURES.flatMap((fixture, index) => eventsFor(fixture, index * 10 + 1));
  const groups = deriveGroups(events);

  test.each(FIXTURES.map((fixture) => [fixture.label, fixture]))(
    "labels %s correctly",
    (_label, fixture) => {
      const fingerprint = signalFingerprint(fixture.tool, fixture.error);
      const labelled = groups.filter((group) => group.fingerprint === fingerprint);
      expect(labelled.map((group) => group.piCore)).toStrictEqual([fixture.piCore]);
    },
  );

  test("labels no record Pi core unless its fixture is", () => {
    const expected = FIXTURES.filter((fixture) => fixture.piCore).map((fixture) =>
      signalFingerprint(fixture.tool, fixture.error),
    );
    const labelled = groups.filter((group) => group.piCore).map((group) => group.fingerprint);
    expect(labelled).toStrictEqual(expected);
  });

  test("leaves Pi core groups out of the ready queue", () => {
    const piCore = groups.filter((group) => group.piCore);
    expect(piCore.map((group) => group.ready)).toStrictEqual([false]);
  });

  test("excludes batch-ordered and outside-service records from the count", () => {
    const excluded = groups.filter((group) => group.excluded > 0).map((group) => group.records);
    expect(excluded).toStrictEqual([0, 0]);
  });
});
