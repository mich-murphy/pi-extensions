import assert from "node:assert/strict";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { assertHegel, propertySettings } from "../../../test-support/hegel-settings";
import type { LedgerEvent } from "../ledger.ts";
import { deriveGroups } from "../queue.ts";
import type { Group } from "../queue.ts";
import { signal, verdictEvent } from "./events.ts";
import type { SignalOptions } from "./events.ts";

const OWNERS = ["pi-claude", "unattributed"] as const;
const FINGERPRINTS = ["bash: ls: unrecognized option", "read: ENOENT"] as const;
const SESSIONS = ["a", "b", "c"] as const;
const settings = propertySettings(200);

type Drawn = {
  readonly events: readonly LedgerEvent[];
  readonly records: readonly Extract<LedgerEvent, { readonly type: "signal" }>[];
};

function drawScore(tc: TestCase, label: string): number {
  return tc.draw(gs.floats({ minValue: 0, maxValue: 1 }), label);
}

function drawEvents(tc: TestCase): Drawn {
  const count = tc.draw(gs.integers({ minValue: 0, maxValue: 12 }), "count");
  const records: Extract<LedgerEvent, { readonly type: "signal" }>[] = [];
  const verdicts: LedgerEvent[] = [];
  for (let n = 1; n <= count; n += 1) {
    const fingerprint = tc.draw(gs.sampledFrom([...FINGERPRINTS]), "fingerprint");
    const piPath = tc.draw(gs.booleans(), "piPath");
    const batchOrdered = tc.draw(gs.booleans(), "batchOrdered");
    const options: Omit<SignalOptions, "evidence" | "cause"> & {
      evidence?: NonNullable<SignalOptions["evidence"]>;
      cause?: NonNullable<SignalOptions["cause"]>;
    } = {
      n,
      session: tc.draw(gs.sampledFrom([...SESSIONS]), "session"),
      owner: tc.draw(gs.sampledFrom([...OWNERS]), "owner"),
      fingerprint,
    };
    if (piPath) {
      options.evidence = "pi-path";
    }
    if (batchOrdered) {
      options.cause = "parallel-batch";
    }
    const made = signal(options);
    assert.ok(made.type === "signal");
    records.push(made);
    if (tc.draw(gs.booleans(), "verdict")) {
      verdicts.push(
        verdictEvent(100 + n, fingerprint, {
          harnessPath: drawScore(tc, "harnessPath"),
          pathExisted: drawScore(tc, "pathExisted"),
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

  test("never labels a group Pi core without a verdict", () => {
    assertHegel(settings, (tc) => {
      const { records } = drawEvents(tc);
      assert.ok(deriveGroups(records).every((group) => !group.piCore));
    });
  });
});
