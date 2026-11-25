import assert from "node:assert/strict";
import { Hegel } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { propertySettings, propertyTimeout } from "../../../test-support/hegel-settings";
import { MAX_BUDGET_MS } from "../protocol/schema.js";
import { createState } from "../state/core.js";
import type { SessionState } from "../state/core.js";
import type { Delivery } from "../state/types.js";

const receiver = { machineId: "beta", sessionId: "receiver", runtimeNonce: "b".repeat(32) };
const sender = { machineId: "alpha", sessionId: "sender", runtimeNonce: "a".repeat(32) };
const settings = propertySettings(200);

type Step = {
  action: number;
  id: number;
  body: number;
  advance: number;
  size: number;
  resend: number;
};

type ModelReceipt = {
  body: string;
  admittedAt: number;
  active: boolean;
  key: string;
  bytes: number;
};

type Model = {
  now: number;
  authorized: boolean;
  queue: boolean;
  offers: number;
  entries: Map<number, ModelReceipt>;
};

function expire(model: Model): void {
  for (const [id, receipt] of model.entries) {
    if (!receipt.active && model.now >= receipt.admittedAt + 600_000) {
      model.entries.delete(id);
    }
  }
}

function activeBytes(model: Model): number {
  return [...model.entries.values()]
    .filter((receipt) => receipt.active)
    .reduce((sum, receipt) => sum + receipt.bytes, 0);
}

const INBOX_BYTES = 1300;

function contentFor(model: Model, step: Step): string {
  const prior = model.entries.get(step.id);

  return prior !== undefined && step.resend === 0
    ? prior.body
    : `value:${step.body}:${"x".repeat(step.size)}`;
}

function inputFor(id: number, content: string) {
  return {
    from: sender,
    to: receiver,
    scopeId: "team",
    message: { id: id.toString(16).padStart(32, "0"), kind: "update", format: "text", content },
  } as const;
}

function deliveryBytes(id: number, content: string): number {
  return (
    Buffer.byteLength(
      JSON.stringify({
        v: 2,
        op: "deliver",
        rid: "0".repeat(32),
        budgetMs: MAX_BUDGET_MS,
        ...inputFor(id, content),
      }),
    ) + 4
  );
}

const baseBytes = deliveryBytes(0, "value:0:");

function expectedAdmission(model: Model, step: Step, bytes: number, content: string): string {
  if (!model.authorized) {
    return "forbidden";
  }

  const prior = model.entries.get(step.id);

  if (prior !== undefined) {
    return prior.body === content ? "admitted" : "id_conflict";
  }

  if (model.entries.size === 5) {
    return "receipts";
  }

  const active = [...model.entries.values()].filter((entry) => entry.active).length;

  return active >= 3 || activeBytes(model) + bytes > INBOX_BYTES || !model.queue
    ? "inbox"
    : "admitted";
}

function applySend(state: SessionState, model: Model, step: Step): void {
  const content = contentFor(model, step);
  const input = inputFor(step.id, content);
  const bytes = deliveryBytes(step.id, content);
  const expected = expectedAdmission(model, step, bytes, content);
  const actual = state.admit(input);
  const decision = actual.tag === "admitted" ? "admitted" : actual.code;

  const reason =
    actual.tag === "not_admitted" && actual.code === "overloaded" ? actual.resource : decision;

  assert.equal(reason, expected);

  if (expected === "admitted" && !model.entries.has(step.id)) {
    model.entries.set(step.id, {
      body: content,
      admittedAt: model.now,
      active: true,
      key: JSON.stringify([
        sender.machineId,
        sender.sessionId,
        sender.runtimeNonce,
        receiver.machineId,
        receiver.sessionId,
        receiver.runtimeNonce,
        "team",
        input.message.id,
      ]),
      bytes,
    });
    model.offers++;
  }
}

function applyPayloadControl(state: SessionState, model: Model, step: Step): void {
  const entry = model.entries.get(step.id);

  if (entry === undefined) {
    return;
  }

  if (step.action === 2) {
    state.retire(entry.key);
    entry.active = false;
  } else {
    state.take(entry.key);
  }
}

function applyEnvironmentControl(model: Model, step: Step): void {
  switch (step.action) {
    case 4: {
      model.now += step.advance;
      break;
    }

    case 5: {
      model.authorized = !model.authorized;
      break;
    }

    case 6: {
      model.queue = !model.queue;
      break;
    }

    default: {
      throw new Error("Invalid generated environment action");
    }
  }
}

function applyStep(state: SessionState, model: Model, step: Step): void {
  expire(model);

  if (step.action === 2 || step.action === 3) {
    applyPayloadControl(state, model, step);
  } else if (step.action >= 4 && step.action <= 6) {
    applyEnvironmentControl(model, step);
  } else {
    applySend(state, model, step);
  }

  expire(model);
  const stats = state.stats();
  assert.equal(stats.receipts, model.entries.size);
  assert.equal(
    stats.inboxMessages,
    [...model.entries.values()].filter((receipt) => receipt.active).length,
  );
  assert.equal(stats.inboxBytes, activeBytes(model));
}

function assertAdmissionTrace(steps: readonly Step[]): void {
  const model: Model = { now: 0, authorized: true, queue: true, offers: 0, entries: new Map() };
  const offers: Delivery[] = [];

  const state = createState({
    peer: receiver,
    scopeIds: ["team"],
    clock: () => model.now,
    authorize: () => model.authorized,
    offer: (delivery) => {
      if (!model.queue) {
        return false;
      }

      offers.push(delivery);

      return true;
    },
    limits: { inboxMessages: 3, inboxBytes: INBOX_BYTES, receipts: 5 },
  });

  for (const step of steps) {
    applyStep(state, model, step);
    assert.equal(offers.length, model.offers);
  }
}

const sizeGenerator = gs.oneOf(
  gs.integers({ minValue: 0, maxValue: INBOX_BYTES + 100 }),
  gs.sampledFrom(
    [1, 2].flatMap((count) =>
      [-1, 0, 1].map((delta) => Math.max(0, Math.floor(INBOX_BYTES / count) - baseBytes + delta)),
    ),
  ),
);

function assertSingleDelivery(size: number, unit: string): void {
  const content = unit.repeat(size) || "x";

  const state = createState({
    peer: receiver,
    scopeIds: ["team"],
    clock: () => 0,
    authorize: () => true,
    offer: () => true,
    limits: { inboxMessages: 3, inboxBytes: INBOX_BYTES, receipts: 5 },
  });

  const bytes = deliveryBytes(1, content);
  const actual = state.admit(inputFor(1, content));

  if (bytes <= INBOX_BYTES) {
    assert.equal(actual.tag, "admitted");
    assert.equal(state.stats().inboxBytes, bytes);
  } else {
    assert.deepStrictEqual(
      actual.tag === "not_admitted" && actual.code === "overloaded"
        ? [actual.code, actual.resource]
        : actual.tag,
      ["overloaded", "inbox"],
    );
    assert.equal(state.stats().inboxBytes, 0);
  }
}

const advanceGenerator = gs.oneOf(
  gs.integers({ minValue: 0, maxValue: 700_000 }),
  gs.sampledFrom([1, 299_999, 300_000, 300_001, 599_999, 600_000]),
);

describe("Hegel bounded state/fault traces against independent models", () => {
  test(
    "admission, lost ACK retries, queue failure, retirement and expiry model",
    { timeout: propertyTimeout(30_000) },
    () => {
      new Hegel((tc) => {
        const count = tc.draw(gs.integers({ minValue: 0, maxValue: 40 }), "length");
        const steps: Step[] = [];

        for (let index = 0; index < count; index++) {
          steps.push({
            action: tc.draw(gs.integers({ minValue: 0, maxValue: 7 }), `action${index}`),
            id: tc.draw(gs.integers({ minValue: 0, maxValue: 7 }), `id${index}`),
            body: tc.draw(gs.integers({ minValue: 0, maxValue: 3 }), `body${index}`),
            advance: tc.draw(advanceGenerator, `advance${index}`),
            size: tc.draw(sizeGenerator, `size${index}`),
            resend: tc.draw(gs.integers({ minValue: 0, maxValue: 2 }), `resend${index}`),
          });
        }

        assertAdmissionTrace(steps);
      })
        .settings(settings)
        .runSync();
    },
  );

  test("single delivery admission flips exactly at the inbox byte limit", () => {
    new Hegel((tc) => {
      const unit = tc.draw(gs.sampledFrom(["x", "é", "界", "😀"]), "unit");
      const width = Buffer.byteLength(unit);
      const edge = Math.floor((INBOX_BYTES - baseBytes + 8) / width);

      const size = tc.draw(
        gs.oneOf(
          gs.sampledFrom([edge - 2, edge - 1, edge, edge + 1, edge + 2]),
          gs.integers({ minValue: 1, maxValue: 2 * edge }),
        ),
        "size",
      );

      assertSingleDelivery(size, unit);
    })
      .settings(settings)
      .runSync();
  });
});
