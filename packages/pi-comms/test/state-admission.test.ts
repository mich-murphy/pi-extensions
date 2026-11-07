import { describe, expect, test } from "vitest";
import { scopedMessageKey } from "../protocol/identity.js";
import { createState } from "../state/core.js";
import type { Delivery, Limits } from "../state/types.js";

const peer = { machineId: "beta", sessionId: "b", runtimeNonce: "b".repeat(32) };
const sender = { machineId: "alpha", sessionId: "a", runtimeNonce: "a".repeat(32) };
const third = { ...sender, sessionId: "third" };
const message = { id: "1".repeat(32), kind: "request", format: "text", content: "work" } as const;
const input = { from: sender, to: peer, scopeId: "team", message };
const key = scopedMessageKey(sender, peer, "team", message.id);
function harness(limits: Partial<Limits> = {}) {
  let now = 0;
  let authorized = true;
  let available = true;
  const offered: Delivery[] = [];
  const state = createState({
    peer,
    scopeIds: ["team", "other"],
    clock: () => now,
    authorize: () => authorized,
    offer: (delivery) => {
      if (!available) {
        return false;
      }
      offered.push(delivery);
      return true;
    },
    limits,
  });
  return {
    state,
    offered,
    clock: (value: number) => {
      now = value;
    },
    policy: (value: boolean) => {
      authorized = value;
    },
    queue: (value: boolean) => {
      available = value;
    },
  };
}

describe("synchronous bounded admission and protected receipts", () => {
  test("lost receipt and simultaneous same-key retries enqueue once even at full capacity", () => {
    const h = harness({ inboxMessages: 1, receipts: 1 });
    const first = h.state.admit(input);
    expect(first.tag).toBe("admitted");
    expect(h.state.admit(input)).toStrictEqual(first);
    expect(h.state.admit({ ...input, message: { ...message, content: "changed" } })).toMatchObject({
      tag: "not_admitted",
      code: "id_conflict",
    });
    expect(h.state.admit({ ...input, message: { ...message, id: "2".repeat(32) } })).toMatchObject({
      tag: "not_admitted",
      code: "overloaded",
      resource: "receipts",
    });
    expect(h.offered).toHaveLength(1);
  });

  test("Escape retirement does not undo admission or restore a protected duplicate", () => {
    const h = harness();
    const receipt = h.state.admit(input);
    expect(h.state.take(key)).toMatchObject({ key, message });
    expect(h.state.take(key)).toBeUndefined();
    expect(h.state.stats().inboxMessages).toBe(1);
    expect(h.state.retire(key)).toBe(true);
    expect(h.state.retire(key)).toBe(false);
    expect(h.state.stats()).toMatchObject({ inboxMessages: 0, inboxBytes: 0, receipts: 1 });
    expect(h.state.admit(input)).toStrictEqual(receipt);
    expect(h.state.take()).toBeUndefined();
    expect(h.offered).toHaveLength(1);
  });

  test("TTL is measured from first admission, duplicates never refresh it, active outlives TTL", () => {
    const h = harness();
    h.state.admit(input);
    h.clock(599_999);
    h.state.admit(input);
    h.clock(600_000);
    expect(h.state.stats().receipts).toBe(1);
    h.state.retire(key);
    expect(h.state.stats().receipts).toBe(0);
    expect(h.state.admit(input).tag).toBe("admitted");
    expect(h.offered).toHaveLength(2);
  });

  test("reconnect preserves a surviving core; replacement nonce is a new runtime", () => {
    const h = harness();
    const receipt = h.state.admit(input);
    expect(h.state.admit(input)).toStrictEqual(receipt);
    const replacement = createState({
      peer: { ...peer, runtimeNonce: "c".repeat(32) },
      scopeIds: ["team"],
      clock: () => 0,
      authorize: () => true,
      offer: () => true,
    });
    expect(replacement.admit(input)).toMatchObject({ tag: "not_admitted", code: "no_route" });
    expect(replacement.admit({ ...input, to: { ...peer, runtimeNonce: "c".repeat(32) } }).tag).toBe(
      "admitted",
    );
  });

  test("current authorization precedes retained duplicate lookup", () => {
    const h = harness();
    h.state.admit(input);
    h.policy(false);
    expect(h.state.admit(input)).toMatchObject({ tag: "not_admitted", code: "forbidden" });
    h.policy(true);
    expect(h.state.admit(input).tag).toBe("admitted");
    expect(h.offered).toHaveLength(1);
  });

  test("queue refusal rolls back all receipt, relation and payload reservations", () => {
    const h = harness();
    h.queue(false);
    expect(h.state.admit(input)).toMatchObject({
      tag: "not_admitted",
      code: "overloaded",
      resource: "inbox",
    });
    expect(h.state.stats()).toMatchObject({
      inboxMessages: 0,
      inboxBytes: 0,
      receipts: 0,
      relations: 0,
    });
    h.queue(true);
    expect(h.state.admit(input).tag).toBe("admitted");
  });

  test.each([
    { limits: { inboxMessages: 0 }, resource: "inbox" },
    { limits: { inboxBytes: 1 }, resource: "inbox" },
    { limits: { receipts: 0 }, resource: "receipts" },
    { limits: { relationsAndInterests: 0 }, resource: "relations" },
    { limits: { recipientsPerWork: 0 }, resource: "relations" },
  ])("capacity refusal is pre-admission: $resource $limits", ({ limits, resource }) => {
    const h = harness(limits);
    expect(h.state.admit(input)).toMatchObject({
      tag: "not_admitted",
      code: "overloaded",
      resource,
    });
    expect(h.offered).toHaveLength(0);
    expect(h.state.stats().receipts).toBe(0);
  });

  test("outgoing exact request relations verify replies; known scope/recipient mismatch rejects", () => {
    const h = harness();
    expect(h.state.rememberOutgoing({ to: sender, scopeId: "team", message }).tag).toBe("ok");
    const reply = {
      ...message,
      id: "2".repeat(32),
      kind: "reply",
      replyTo: { sender: peer, messageId: message.id },
    } as const;
    expect(h.state.admit({ ...input, message: reply })).toMatchObject({
      tag: "admitted",
      correlation: "verified",
    });
    expect(h.state.admit({ ...input, scopeId: "other", message: reply })).toMatchObject({
      tag: "not_admitted",
      code: "invalid_correlation",
    });
    expect(h.state.admit({ ...input, from: third, message: reply })).toMatchObject({
      tag: "not_admitted",
      code: "invalid_correlation",
    });
  });

  test("expired correlation yields unresolved, retained admitted receipt keeps original classification", () => {
    const h = harness();
    h.state.rememberOutgoing({ to: sender, scopeId: "team", message });
    const reply = {
      ...message,
      id: "2".repeat(32),
      kind: "reply",
      replyTo: { sender: peer, messageId: message.id },
    } as const;
    const receipt = h.state.admit({ ...input, message: reply });
    h.clock(86_400_000);
    expect(h.state.admit({ ...input, message: reply })).toStrictEqual(receipt);
    expect(h.state.admit({ ...input, message: { ...reply, id: "3".repeat(32) } })).toMatchObject({
      tag: "admitted",
      correlation: "unresolved",
    });
  });

  test("wrong reply target is a typed semantic rejection and work does not verify correlation", () => {
    const h = harness();
    const reply = {
      ...message,
      kind: "reply",
      replyTo: { sender: third, messageId: message.id },
    } as const;
    expect(h.state.admit({ ...input, message: reply })).toMatchObject({
      tag: "not_admitted",
      code: "invalid_correlation",
    });
    expect(
      h.state.admit({
        ...input,
        message: {
          ...reply,
          replyTo: { sender: peer, messageId: message.id },
          work: { kind: "request", origin: peer, requestId: message.id },
        },
      }),
    ).toMatchObject({ tag: "admitted", correlation: "unresolved" });
  });

  test("scope and optional absence remain part of identity", () => {
    const h = harness();
    h.state.admit(input);
    expect(h.state.admit({ ...input, message: { ...message, refs: [] } })).toMatchObject({
      tag: "not_admitted",
      code: "id_conflict",
    });
    expect(h.state.admit({ ...input, scopeId: "other" }).tag).toBe("admitted");
    expect(h.offered).toHaveLength(2);
  });
  test("post-retention re-admission replaces its old relation rather than consuming a second slot", () => {
    const h = harness({ relationsAndInterests: 1 });
    h.state.admit(input);
    h.state.retire(key);
    h.clock(600_000);
    expect(h.state.admit(input).tag).toBe("admitted");
    expect(h.state.stats().relations).toBe(1);
    expect(h.offered).toHaveLength(2);
  });

  test("clock regression and callback re-entry fail closed without an admission claim", () => {
    const h = harness();
    h.clock(100);
    h.state.stats();
    h.clock(99);
    expect(() => h.state.stats()).toThrow(TypeError);
    const state = createState({
      peer,
      scopeIds: ["team"],
      clock: () => 0,
      authorize: () => true,
      offer: () => {
        state.stats();
        return true;
      },
    });
    expect(() => state.admit(input)).toThrow("Session state callback re-entry is forbidden");
    expect(state.stats().receipts).toBe(0);
  });
});
