import { describe, expect, test } from "vitest";
import { groupId } from "../fingerprint.ts";
import { deriveGroups } from "../queue.ts";
import { reopenEvent, report, resolveEvent, signal } from "./events.ts";

const claudeGroup = groupId("pi-claude", "read: ENOENT");

describe("deriveGroups", () => {
  test("groups records by owner and fingerprint", () => {
    const groups = deriveGroups([
      signal({ n: 1, session: "a" }),
      signal({ n: 2, session: "b" }),
      signal({ n: 3, session: "a", owner: "pi-core" }),
    ]);
    expect(groups.map((group) => [group.owner, group.records, group.sessions])).toStrictEqual([
      ["pi-claude", 2, 2],
      ["pi-core", 1, 1],
    ]);
  });

  test("is ready only after two sessions", () => {
    const one = deriveGroups([signal({ n: 1, session: "a" }), signal({ n: 2, session: "a" })]);
    const two = deriveGroups([signal({ n: 1, session: "a" }), signal({ n: 2, session: "b" })]);
    expect(one[0]?.ready).toBe(false);
    expect(two[0]?.ready).toBe(true);
  });

  test.each(["pi-core", "unattributed"])("never makes a %s group ready", (owner) => {
    const groups = deriveGroups([
      signal({ n: 1, session: "a", owner }),
      signal({ n: 2, session: "b", owner }),
      signal({ n: 3, session: "c", owner }),
    ]);
    expect(groups[0]?.ready).toBe(false);
  });

  test("ranks by sessions times records and doubles a blocked group", () => {
    const groups = deriveGroups([
      signal({ n: 1, session: "a" }),
      signal({ n: 2, session: "b" }),
      report({ n: 3, session: "a", impact: "blocked" }),
      report({ n: 4, session: "b" }),
    ]);
    expect(groups.map((group) => [group.fingerprint, group.rank, group.blocked])).toStrictEqual([
      ["pi-claude/workaround", 8, true],
      ["read: ENOENT", 4, false],
    ]);
  });

  test("puts ready groups before higher-ranked ones that are not", () => {
    const groups = deriveGroups([
      signal({ n: 1, session: "a", owner: "pi-core" }),
      signal({ n: 2, session: "b", owner: "pi-core" }),
      signal({ n: 3, session: "c", owner: "pi-core" }),
      signal({ n: 4, session: "a" }),
      signal({ n: 5, session: "b" }),
    ]);
    expect(groups.map((group) => group.owner)).toStrictEqual(["pi-claude", "pi-core"]);
  });

  test("clears a resolved group and reopens it on a new record", () => {
    const resolved = deriveGroups([
      signal({ n: 1, session: "a" }),
      signal({ n: 2, session: "b" }),
      resolveEvent(3, claudeGroup),
    ]);
    expect(resolved[0]).toMatchObject({ status: "resolved", records: 0, ready: false, rank: 0 });
    expect(resolved[0]?.resolution).toStrictEqual({
      commit: "abc1234",
      layer: "architecture",
      at: resolved[0]?.lastAt,
    });

    const reopened = deriveGroups([
      signal({ n: 1, session: "a" }),
      resolveEvent(2, claudeGroup),
      signal({ n: 3, session: "c" }),
    ]);
    expect(reopened[0]).toMatchObject({ status: "reopened", records: 1, sessions: 1 });
  });

  test("reopens a resolved group by hand", () => {
    const groups = deriveGroups([
      signal({ n: 1, session: "a" }),
      resolveEvent(2, claudeGroup),
      reopenEvent(3, claudeGroup),
    ]);
    expect(groups[0]?.status).toBe("reopened");
  });

  test("ignores a reopen of a group that is still open", () => {
    const groups = deriveGroups([signal({ n: 1, session: "a" }), reopenEvent(2, claudeGroup)]);
    expect(groups[0]?.status).toBe("open");
  });

  test("ignores resolve and reopen events for unknown groups", () => {
    expect(
      deriveGroups([resolveEvent(1, "0123456789ab"), reopenEvent(2, "0123456789ab")]),
    ).toHaveLength(0);
  });

  test("counts an event seen in two ledgers once", () => {
    const events = [signal({ n: 1, session: "a" }), signal({ n: 2, session: "b" })];
    expect(deriveGroups([...events, ...events])).toStrictEqual(deriveGroups(events));
  });

  test("shows the latest record as a short example", () => {
    const groups = deriveGroups([
      signal({ n: 1, session: "a", error: "first" }),
      signal({ n: 2, session: "b", error: `latest\n${"y".repeat(200)}` }),
    ]);
    expect(groups[0]?.example.startsWith("latest y")).toBe(true);
    expect(groups[0]?.example).toHaveLength(80);
  });
});
