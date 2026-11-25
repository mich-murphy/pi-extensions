import { describe, expect, test } from "vitest";
import { THRESHOLDS } from "../jev.ts";
import type { RecordEvent, VerdictEvent } from "../ledger.ts";
import { isExcluded, isPiCore } from "../verdict.ts";
import type { PiCoreCandidate } from "../verdict.ts";

const verdict: VerdictEvent = {
  type: "verdict",
  id: "00000000-0000-4000-8000-000000000001",
  at: "2026-11-25T00:00:00.000Z",
  fingerprint: "bash: ls: unrecognized option",
  model: "typesafe/jev-1.14.0",
  harnessPath: 0.9,
  pathExisted: 0.9,
  outsideService: 0.02,
};

type RecordShape = { readonly piPath?: boolean; readonly batchOrdered?: boolean };

function record(session: string, shape: RecordShape = {}): RecordEvent {
  const { piPath = true, batchOrdered = false } = shape;
  return {
    type: "signal",
    id: `00000000-0000-4000-8000-${session.padStart(12, "0")}`,
    at: "2026-11-25T00:00:00.000Z",
    session,
    owner: "unattributed",
    fingerprint: verdict.fingerprint,
    tool: "bash",
    error: "ls: unrecognized option",
    ...(piPath ? { evidence: "pi-path" as const } : {}),
    ...(batchOrdered ? { cause: "parallel-batch" as const } : {}),
  };
}

const passing: PiCoreCandidate = {
  owner: "unattributed",
  live: [record("a"), record("b")],
  excluded: [],
  sessions: 2,
  verdicts: [verdict],
};

describe("isPiCore", () => {
  test("passes when every check passes", () => {
    expect(isPiCore(passing)).toBe(true);
  });

  test.each<[string, Partial<PiCoreCandidate>]>([
    ["an owner from this repository", { owner: "pi-claude" }],
    ["one session", { sessions: 1 }],
    ["no live records", { live: [] }],
    ["a record without a Pi path", { live: [record("a"), record("b", { piPath: false })] }],
    ["a batch-ordered record", { excluded: [record("c", { batchOrdered: true })] }],
    ["no verdict", { verdicts: [] }],
    ["a fingerprint without a verdict", { verdicts: [verdict, undefined] }],
    [
      "a low harness-path score",
      { verdicts: [{ ...verdict, harnessPath: THRESHOLDS.harnessPath - 0.01 }] },
    ],
    ["a low path-existed score", { verdicts: [{ ...verdict, pathExisted: 0.5 }] }],
    [
      "an outside service",
      { verdicts: [{ ...verdict, outsideService: THRESHOLDS.piCoreOutsideBelow }] },
    ],
  ])("fails with %s", (_name, change) => {
    expect(isPiCore({ ...passing, ...change })).toBe(false);
  });
});

describe("isExcluded", () => {
  test.each<[string, RecordEvent, VerdictEvent | undefined, boolean]>([
    ["an ordinary record", record("a"), verdict, false],
    ["a record with no verdict", record("a"), undefined, false],
    ["a batch-ordered record", record("a", { batchOrdered: true }), undefined, true],
    ["an outside-service verdict", record("a"), { ...verdict, outsideService: 0.95 }, true],
  ])("treats %s as excluded: %s", (_name, event, given, expected) => {
    expect(isExcluded(event, given)).toBe(expected);
  });
});
