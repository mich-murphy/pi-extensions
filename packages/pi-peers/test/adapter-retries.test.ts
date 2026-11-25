import { describe, expect, test } from "vitest";
import { UnsureSends } from "../adapter/retries.js";
import { scopedMessageKey } from "../protocol/identity.js";
import { createState } from "../state/core.js";

const sender = { machineId: "alpha", sessionId: "a", runtimeNonce: "a".repeat(32) };
const receiver = { machineId: "beta", sessionId: "b", runtimeNonce: "b".repeat(32) };
const message = { id: "1".repeat(32), kind: "update", format: "text", content: "work" } as const;
const input = { from: sender, to: receiver, scopeId: "team", message };

function retryAllowedAt(elapsed: number): boolean {
  let now = 0;
  const unsure = new UnsureSends(() => now);
  unsure.record({ handle: "s-0000", to: receiver, scopeId: "team", message });
  now = elapsed;

  return unsure.lookup(message.id)?.expired === false;
}

function lastRetryMoment(): number {
  let low = 0;
  let high = 24 * 60 * 60 * 1000;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if (retryAllowedAt(middle)) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return low;
}

describe("retryOf window", () => {
  test("a retry at the last allowed moment is still a duplicate to a receiver with default limits", () => {
    const last = lastRetryMoment();
    expect(retryAllowedAt(last + 1)).toBe(false);
    let now = 0;
    const offered: unknown[] = [];

    const state = createState({
      peer: receiver,
      scopeIds: ["team"],
      clock: () => now,
      authorize: () => true,
      offer: (delivery) => {
        offered.push(delivery);

        return true;
      },
    });

    const receipt = state.admit(input);
    state.retire(scopedMessageKey(sender, receiver, "team", message.id));
    now = last;
    expect(state.admit(input)).toStrictEqual(receipt);
    expect(offered).toHaveLength(1);
  });
});
