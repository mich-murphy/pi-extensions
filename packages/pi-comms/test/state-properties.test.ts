import assert from "node:assert/strict";
import { Database, Hegel } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { createState } from "../state/core.js";
import type { SessionState } from "../state/core.js";
import type { Delivery, PublicationRecord } from "../state/types.js";

const receiver = { machineId: "beta", sessionId: "receiver", runtimeNonce: "b".repeat(32) };
const sender = { machineId: "alpha", sessionId: "sender", runtimeNonce: "a".repeat(32) };
const settings = { testCases: 200, seed: 12_345n, database: Database.disabled, printBlob: true };
type Step = { action: number; id: number; body: number; advance: number; size: number };
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
function contentFor(step: Step): string {
  return `value:${step.body}:${"x".repeat(step.size)}`;
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
      JSON.stringify({ v: 1, op: "deliver", rid: "0".repeat(32), ...inputFor(id, content) }),
    ) + 4
  );
}
const baseBytes = deliveryBytes(0, "value:0:");
function expectedAdmission(model: Model, step: Step, bytes: number): string {
  if (!model.authorized) {
    return "forbidden";
  }
  const prior = model.entries.get(step.id);
  if (prior !== undefined) {
    return prior.body === contentFor(step) ? "admitted" : "id_conflict";
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
  const content = contentFor(step);
  const input = inputFor(step.id, content);
  const bytes = deliveryBytes(step.id, content);
  const expected = expectedAdmission(model, step, bytes);
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

type InterestModel = {
  now: number;
  active: boolean;
  expiresAt: number;
  terminal: boolean;
  revision: number;
  slots: boolean;
};
const publishedWork = { kind: "publication", publisher: receiver, key: "root" } as const;
const workRecord: PublicationRecord = {
  category: "work",
  work: publishedWork,
  title: "Work",
  summary: "Report",
  format: "text",
  preparation: "authored",
  status: "in_progress",
};
function assertReportTransition(state: SessionState, model: InterestModel, action: number): void {
  const isTerminal = action === 2;
  const before = model.active;
  const result = state.prepareReport({
    scopeId: "team",
    key: "report",
    record: { ...workRecord, status: isTerminal ? "completed" : "in_progress" },
    notify: "interested",
  });
  if (before && !model.slots) {
    assert.deepStrictEqual(result, { tag: "error", code: "overloaded", resource: "operations" });
    return;
  }
  assert.ok(result.tag === "ok");
  model.terminal = isTerminal;
  assert.equal(result.value.pushes.length, Number(before));
  assert.equal(result.value.consumedInterests.length, Number(before && isTerminal));
  model.active = before && !isTerminal;
  model.revision++;
}
function applyInterestAction(state: SessionState, model: InterestModel, action: number): void {
  const input = { subscriber: sender, scopeId: "team", work: publishedWork };
  switch (action) {
    case 0: {
      const result = state.interest.add(input);
      assert.ok(result.tag === "ok");
      assert.equal(result.value.active, !model.terminal);
      model.active = !model.terminal;
      model.expiresAt = model.now + 86_400_000;
      break;
    }
    case 1: {
      state.interest.remove(input);
      model.active = false;
      break;
    }
    case 4: {
      model.now += 86_400_000;
      model.active = false;
      break;
    }
    case 5:
    case 6: {
      model.slots = action === 6;
      break;
    }
    default: {
      assertReportTransition(state, model, action);
    }
  }
}
function assertInterestSnapshot(state: SessionState, model: InterestModel): void {
  assert.equal(state.stats().interests, Number(model.active));
  assert.equal(state.stats().revision, model.revision);
  const snapshot = state.read({ caller: sender, scopeId: "team", key: "report" });
  assert.ok(snapshot.tag === "ok");
  assert.equal(snapshot.value.publication.status, model.terminal ? "completed" : "in_progress");
  assert.equal(snapshot.value.publication.revision, model.revision);
}
function assertInterestTrace(actions: readonly number[]): void {
  const model: InterestModel = {
    now: 0,
    active: false,
    expiresAt: 0,
    terminal: false,
    revision: 1,
    slots: true,
  };
  let ids = 0;
  const state = createState({
    peer: receiver,
    scopeIds: ["team"],
    clock: () => model.now,
    authorize: () => true,
    offer: () => true,
    newMessageId: () => (++ids).toString(16).padStart(32, "0"),
    reservePushes: () => model.slots,
  });
  state.publish({ scopeId: "team", key: "report", record: workRecord });
  for (const action of actions) {
    if (model.now >= model.expiresAt) {
      model.active = false;
    }
    applyInterestAction(state, model, action);
    assertInterestSnapshot(state, model);
  }
}

// Sizes straddle the single-message limit and its multiples so the byte branch is reached.
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
describe("Hegel bounded state/fault traces against independent models", () => {
  test("admission, lost ACK retries, queue failure, retirement and expiry model", () => {
    new Hegel((tc) => {
      const count = tc.draw(gs.integers({ minValue: 0, maxValue: 40 }), "length");
      const steps: Step[] = [];
      for (let index = 0; index < count; index++) {
        steps.push({
          action: tc.draw(gs.integers({ minValue: 0, maxValue: 7 }), `action${index}`),
          id: tc.draw(gs.integers({ minValue: 0, maxValue: 7 }), `id${index}`),
          body: tc.draw(gs.integers({ minValue: 0, maxValue: 3 }), `body${index}`),
          advance: tc.draw(gs.integers({ minValue: 0, maxValue: 700_000 }), `advance${index}`),
          size: tc.draw(sizeGenerator, `size${index}`),
        });
      }
      assertAdmissionTrace(steps);
    })
      .databaseKey("session-communication/ts/admission-model")
      .settings(settings)
      .runSync();
  });

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
      .databaseKey("session-communication/ts/byte-limit")
      .settings(settings)
      .runSync();
  });

  test("interest/report linearization and lease expiry model", () => {
    new Hegel((tc) => {
      const actions = tc.draw(
        gs.arrays(gs.integers({ minValue: 0, maxValue: 6 }), { maxSize: 32 }),
        "actions",
      );
      assertInterestTrace(actions);
    })
      .databaseKey("session-communication/ts/interest-model")
      .settings(settings)
      .runSync();
  });
});
