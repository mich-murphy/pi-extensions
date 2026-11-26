import assert from "node:assert/strict";
import type { TestCase } from "@hegeldev/hegel";
import { booleans, integers, permutations, sampledFrom } from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { assertHegel, propertySettings } from "../../../test-support/hegel-settings";
import { groupId } from "../fingerprint.ts";
import type { LedgerEvent } from "../ledger.ts";
import { deriveGroups } from "../queue.ts";
import type { Group } from "../queue.ts";
import { ownerEvent, reopenEvent, report, resolveEvent, signal } from "./events.ts";

const OWNERS = ["pi-claude", "pi-skills", "pi-core", "unattributed"] as const;
const FINGERPRINTS = ["read: ENOENT", "bash: timeout"] as const;
const SESSIONS = ["a", "b", "c"] as const;
const settings = propertySettings(200);

function drawEvents(tc: TestCase): Array<LedgerEvent> {
  const count = tc.draw(integers({ minValue: 0, maxValue: 14 }), "count");
  const events: Array<LedgerEvent> = [];

  for (let n = 1; n <= count; n += 1) {
    const owner = tc.draw(sampledFrom([...OWNERS]), "owner");
    const fingerprint = tc.draw(sampledFrom([...FINGERPRINTS]), "fingerprint");
    const session = tc.draw(sampledFrom([...SESSIONS]), "session");
    const fixtureIndex = tc.draw(integers({ minValue: 0, maxValue: 6 }), "shape");
    const probability = tc.draw(sampledFrom([0.85, 0.9, 0.95]), "probability");
    const group = groupId(owner, fingerprint);
    const options = { n, session, owner, fingerprint };

    const make = [
      () => signal(options),
      () => signal(options),
      () => report(options),
      () => report({ ...options, impact: "blocked" }),
      () => resolveEvent(n, group),
      () => reopenEvent(n, group),
      () => ownerEvent(n, fingerprint, owner, probability),
    ][fixtureIndex];

    assert.ok(make !== undefined);
    events.push(make());
  }

  return events;
}

function expectedReady(group: Group): boolean {
  return (
    group.status !== "resolved" &&
    group.owner !== "pi-core" &&
    group.owner !== "unattributed" &&
    group.sessions >= 2
  );
}

function assertGroupInvariants(group: Group): void {
  assert.equal(group.ready, expectedReady(group), JSON.stringify(group));
  assert.ok(group.sessions <= group.records);
  assert.equal(group.rank === 0, group.status === "resolved" || group.records === 0);
}

function assertPriorityOrder(groups: ReadonlyArray<Group>): void {
  for (const [index, after] of groups.entries()) {
    const before = groups[index - 1] ?? after;
    assert.ok(Number(before.ready) >= Number(after.ready));
    assert.ok(before.ready !== after.ready || before.rank >= after.rank);
  }
}

describe("deriveGroups properties", () => {
  test("does not depend on the order ledgers are read in", () => {
    assertHegel(settings, (tc) => {
      const events = drawEvents(tc);
      const shuffled = tc.draw(permutations(events), "shuffled");
      assert.deepEqual(deriveGroups(shuffled), deriveGroups(events));
    });
  });

  test("does not count a copied event twice", () => {
    assertHegel(settings, (tc) => {
      const events = drawEvents(tc);
      const copies = events.filter(() => tc.draw(booleans(), "copy"));
      assert.deepEqual(deriveGroups([...events, ...copies]), deriveGroups(events));
    });
  });

  test("only makes our extensions' open groups with two sessions ready", () => {
    assertHegel(settings, (tc) => {
      for (const group of deriveGroups(drawEvents(tc))) {
        assertGroupInvariants(group);
      }
    });
  });

  test("lists ready groups before the rest, each by rank", () => {
    assertHegel(settings, (tc) => {
      assertPriorityOrder(deriveGroups(drawEvents(tc)));
    });
  });
});
