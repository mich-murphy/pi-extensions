import assert from "node:assert/strict";
import type { TestCase } from "@hegeldev/hegel";
import {
  booleans,
  floats,
  integers,
  sampledFrom,
  weightedBooleans,
} from "@hegeldev/hegel/generators";
import type { Types } from "effect";
import { describe, test } from "vitest";
import { assertHegel, propertySettings } from "../../../test-support/hegel-settings";
import type { LedgerEvent } from "../ledger.ts";
import { deriveGroups } from "../queue.ts";
import type { Group } from "../queue.ts";
import { isOutsideService } from "../verdict.ts";
import { signal, verdictEvent, withoutClassifierEvents } from "./events.ts";
import type { SignalOptions } from "./events.ts";

const OWNERS = ["pi-claude", "unattributed"] as const;
const FINGERPRINTS = ["bash: ls: unrecognized option", "read: ENOENT"] as const;
const TOOLS = ["bash", "read", "webfetch"] as const;
const ERRORS = [
  "ls: unrecognized option",
  "Connection refused by learn.microsoft.com",
  "Request failed (404 Not Found)",
] as const;
const SESSIONS = ["a", "b", "c"] as const;
const settings = propertySettings(200);

type Drawn = {
  readonly events: ReadonlyArray<LedgerEvent>;
  readonly records: ReadonlyArray<Extract<LedgerEvent, { readonly type: "signal" }>>;
};

function drawScore(tc: TestCase, label: string): number {
  return tc.draw(floats({ minValue: 0, maxValue: 1 }), label);
}

function drawEvents(tc: TestCase): Drawn {
  const count = tc.draw(integers({ minValue: 0, maxValue: 12 }), "count");
  const records: Array<Extract<LedgerEvent, { readonly type: "signal" }>> = [];
  const verdicts: Array<LedgerEvent> = [];

  for (let n = 1; n <= count; n += 1) {
    const fingerprint = tc.draw(sampledFrom([...FINGERPRINTS]), "fingerprint");
    const piPath = tc.draw(weightedBooleans(0.8), "piPath");
    const batchOrdered = tc.draw(weightedBooleans(0.2), "batchOrdered");

    const options: Types.Mutable<SignalOptions> = {
      n,
      session: tc.draw(sampledFrom([...SESSIONS]), "session"),
      owner: OWNERS[tc.draw(weightedBooleans(0.7), "unattributed") ? 1 : 0],
      fingerprint,
      tool: tc.draw(sampledFrom([...TOOLS]), "tool"),
      error: tc.draw(sampledFrom([...ERRORS]), "error"),
    };

    if (piPath) {
      options.evidence = "pi-path";
      options.pathExisted = tc.draw(weightedBooleans(0.8), "pathExisted");
    }

    if (batchOrdered) {
      options.cause = "parallel-batch";
    }

    const made = signal(options);
    assert.ok(made.type === "signal");
    records.push(made);

    if (tc.draw(booleans(), "verdict")) {
      verdicts.push(
        verdictEvent(100 + n, fingerprint, {
          harnessPath: drawScore(tc, "harnessPath"),
          outsideService: drawScore(tc, "outsideService"),
        }),
      );
    }
  }

  return { events: [...records, ...verdicts], records };
}

function recordsOf(group: Group, records: Drawn["records"]) {
  return records.filter(
    (record) => record.owner === group.owner && record.fingerprint === group.fingerprint,
  );
}

describe("Pi core label properties", () => {
  test("only labels unattributed groups whose every record names a Pi path", () => {
    assertHegel(settings, (tc) => {
      const { events, records } = drawEvents(tc);

      for (const group of deriveGroups(events).filter((candidate) => candidate.piCore)) {
        const own = recordsOf(group, records);
        assert.equal(group.owner, "unattributed");
        assert.ok(group.sessions >= 2);
        assert.ok(own.every((record) => record.evidence === "pi-path"));
        assert.ok(own.every((record) => record.pathExisted === true));
        assert.ok(own.every((record) => record.cause === undefined));
      }
    });
  });

  test("never makes a Pi core group ready", () => {
    assertHegel(settings, (tc) => {
      const { events } = drawEvents(tc);
      const piCore = deriveGroups(events).filter((group) => group.piCore);
      assert.ok(piCore.every((group) => !group.ready));
    });
  });

  test("never labels a group Pi core that holds an outside-service record", () => {
    assertHegel(settings, (tc) => {
      const { events, records } = drawEvents(tc);

      for (const group of deriveGroups(events).filter((candidate) => candidate.piCore)) {
        assert.ok(recordsOf(group, records).every((record) => !isOutsideService(record)));
      }
    });
  });

  test("ignores older verdicts", () => {
    assertHegel(settings, (tc) => {
      const { events } = drawEvents(tc);
      assert.deepEqual(deriveGroups(events), deriveGroups(withoutClassifierEvents(events)));
    });
  });
});
