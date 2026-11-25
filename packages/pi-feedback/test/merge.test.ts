import { describe, expect, test } from "vitest";
import { groupId } from "../fingerprint.ts";
import { THRESHOLDS } from "../jev.ts";
import type { LedgerEvent } from "../ledger.ts";
import { deriveGroups } from "../queue.ts";
import { reopenEvent, resolveEvent, signal, verdictEvent } from "./events.ts";

function sameCause(
  n: number,
  a: string,
  b: string,
  score: number,
  owner = "pi-claude",
): LedgerEvent {
  return {
    type: "same_cause",
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    at: new Date(Date.UTC(2026, 10, 25, 0, 0, 0, n)).toISOString(),
    owner,
    a,
    b,
    model: "typesafe/jev-1.14.0",
    sameCause: score,
  };
}

const older = signal({ n: 1, session: "a", fingerprint: "read: older" });
const newer = signal({ n: 2, session: "b", fingerprint: "read: newer" });

describe("merging groups", () => {
  test("merges fingerprints of one owner whose same-cause answer reaches the threshold", () => {
    const groups = deriveGroups([
      older,
      newer,
      sameCause(3, "read: newer", "read: older", THRESHOLDS.sameCause),
    ]);

    expect(groups).toMatchObject([
      {
        id: groupId("pi-claude", "read: older"),
        fingerprint: "read: older",
        fingerprints: ["read: newer", "read: older"],
        records: 2,
        sessions: 2,
        ready: true,
      },
    ]);
  });

  test("keeps fingerprints apart below the threshold", () => {
    const groups = deriveGroups([
      older,
      newer,
      sameCause(3, "read: newer", "read: older", THRESHOLDS.sameCause - 0.01),
    ]);

    expect(groups.map((group) => group.fingerprint).toSorted()).toStrictEqual([
      "read: newer",
      "read: older",
    ]);
  });

  test("does not merge across owners", () => {
    const groups = deriveGroups([
      older,
      signal({ n: 2, session: "b", owner: "pi-web", fingerprint: "read: newer" }),
      sameCause(3, "read: newer", "read: older", 0.99),
    ]);

    expect(groups).toHaveLength(2);
  });

  test("merges transitively and names the group after the earliest fingerprint", () => {
    const groups = deriveGroups([
      signal({ n: 5, session: "c", fingerprint: "read: third" }),
      newer,
      older,
      sameCause(6, "read: third", "read: newer", 0.9),
      sameCause(7, "read: newer", "read: older", 0.9),
    ]);

    expect(groups).toMatchObject([{ fingerprint: "read: older", records: 3, sessions: 3 }]);
  });

  test("applies a resolve that names a merged member's old group", () => {
    const groups = deriveGroups([
      older,
      newer,
      sameCause(3, "read: older", "read: newer", 0.9),
      resolveEvent(4, groupId("pi-claude", "read: newer")),
    ]);

    expect(groups).toMatchObject([{ status: "resolved", records: 0 }]);

    const reopened = deriveGroups([
      older,
      newer,
      sameCause(3, "read: older", "read: newer", 0.9),
      resolveEvent(4, groupId("pi-claude", "read: newer")),
      reopenEvent(5, groupId("pi-claude", "read: older")),
    ]);

    expect(reopened).toMatchObject([{ status: "reopened" }]);
  });

  test("ignores a same-cause answer about fingerprints with no records", () => {
    const groups = deriveGroups([older, sameCause(2, "read: ghost", "read: older", 0.9)]);
    expect(groups).toMatchObject([{ fingerprint: "read: older", fingerprints: ["read: older"] }]);
  });

  test("needs every merged fingerprint's verdict to pass for Pi core", () => {
    const piPath = { owner: "unattributed", evidence: "pi-path" } as const;
    const passing = { harnessPath: 0.9, pathExisted: 0.9, outsideService: 0.02 };

    const events = [
      signal({ n: 1, session: "a", fingerprint: "bash: one", ...piPath }),
      signal({ n: 2, session: "b", fingerprint: "bash: two", ...piPath }),
      sameCause(3, "bash: one", "bash: two", 0.9, "unattributed"),
      verdictEvent(4, "bash: one", passing),
    ];

    expect(deriveGroups(events)).toMatchObject([{ piCore: false }]);
    expect(deriveGroups([...events, verdictEvent(5, "bash: two", passing)])).toMatchObject([
      { piCore: true, ready: false },
    ]);
  });
});
