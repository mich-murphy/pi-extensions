import { describe, expect, test } from "vitest";
import { groupId } from "../fingerprint.ts";
import { deriveGroups } from "../queue.ts";
import { ownerEvent, reopenEvent, report, resolveEvent, signal } from "./events.ts";

const VAGUE = "the search tool/tool_error";

function vague(n: number, session: string) {
  return report({ n, session, owner: "unattributed", fingerprint: VAGUE });
}

describe("answered owners in the queue", () => {
  test("moves a vague report to one of our packages at 0.9 or more", () => {
    const groups = deriveGroups([
      vague(1, "a"),
      vague(2, "b"),
      ownerEvent(3, VAGUE, "pi-web", 0.93),
    ]);

    expect(groups).toMatchObject([
      { id: groupId("pi-web", VAGUE), owner: "pi-web", records: 2, ready: true },
    ]);
  });

  test.each([
    ["below 0.9", "pi-web", 0.89],
    ["pi-core", "pi-core", 0.99],
    ["other", "other", 0.99],
  ])("keeps a vague report unattributed for an answer %s", (_name, owner, confidence) => {
    const groups = deriveGroups([vague(1, "a"), ownerEvent(2, VAGUE, owner, confidence)]);

    expect(groups.map((group) => group.owner)).toStrictEqual(["unattributed"]);
  });

  test("never moves a report code attributed or a signal", () => {
    const groups = deriveGroups([
      report({ n: 1, session: "a", owner: "pi-claude", fingerprint: VAGUE }),
      signal({ n: 2, session: "a", owner: "unattributed", fingerprint: VAGUE }),
      ownerEvent(3, VAGUE, "pi-web", 0.99),
    ]);

    expect(groups.map((group) => group.owner).toSorted()).toStrictEqual([
      "pi-claude",
      "unattributed",
    ]);
  });

  test("uses the most confident answer when machines disagree", () => {
    const events = [
      vague(1, "a"),
      ownerEvent(2, VAGUE, "pi-web", 0.91),
      ownerEvent(3, VAGUE, "pi-peers", 0.97),
    ];

    expect(deriveGroups(events).map((group) => group.owner)).toStrictEqual(["pi-peers"]);
    expect(deriveGroups(events.toReversed())).toStrictEqual(deriveGroups(events));
  });

  test.each([
    ["pi-core", 0.95],
    ["other", 0.93],
  ])(
    "keeps a vague report unattributed when the most confident answer is %s at %s",
    (owner, confidence) => {
      const events = [
        vague(1, "a"),
        ownerEvent(2, VAGUE, "pi-web", 0.91),
        ownerEvent(3, VAGUE, owner, confidence),
      ];
      const owners = (order: typeof events) => deriveGroups(order).map((group) => group.owner);

      expect(owners(events)).toStrictEqual(["unattributed"]);
      expect(owners(events.toReversed())).toStrictEqual(["unattributed"]);
    },
  );

  test("moves a vague report to the most confident answer when it passes 0.9", () => {
    const events = [
      vague(1, "a"),
      ownerEvent(2, VAGUE, "pi-peers", 0.85),
      ownerEvent(3, VAGUE, "pi-web", 0.91),
    ];

    expect(deriveGroups(events).map((group) => group.owner)).toStrictEqual(["pi-web"]);
    expect(deriveGroups(events.toReversed()).map((group) => group.owner)).toStrictEqual(["pi-web"]);
  });

  test("leaves a report that names an MCP tool unattributed", () => {
    const named = {
      ...vague(1, "a"),
      actual: "mcp__linear__save_issue returned 401",
    };

    expect(
      deriveGroups([named, ownerEvent(2, VAGUE, "pi-web", 0.99)]).map((group) => group.owner),
    ).toStrictEqual(["unattributed"]);
  });
  test("applies a resolve that names the report's original unattributed group", () => {
    const original = groupId("unattributed", VAGUE);
    const groups = deriveGroups([
      vague(1, "a"),
      ownerEvent(2, VAGUE, "pi-web", 0.95),
      resolveEvent(3, original),
    ]);

    expect(groups).toMatchObject([{ owner: "pi-web", status: "resolved", records: 0 }]);
  });

  test("applies a reopen that names the report's original unattributed group", () => {
    const original = groupId("unattributed", VAGUE);
    const groups = deriveGroups([
      vague(1, "a"),
      ownerEvent(2, VAGUE, "pi-web", 0.95),
      resolveEvent(3, groupId("pi-web", VAGUE)),
      reopenEvent(4, original),
    ]);

    expect(groups).toMatchObject([{ owner: "pi-web", status: "reopened" }]);
  });
});
