import { describe, expect, test } from "vitest";
import { scopedMessageKey } from "../protocol/identity.js";
import { createState } from "../state/core.js";
import { defaults } from "../state/shared.js";
import type { AdmitInput } from "../state/types.js";

const peer = { machineId: "beta", sessionId: "b", runtimeNonce: "b".repeat(32) };
const sender = { machineId: "alpha", sessionId: "a", runtimeNonce: "a".repeat(32) };
const id = (index: number) => index.toString(16).padStart(32, "0");

function incoming(index: number, kind: "update" | "request", deliveryBytes?: number): AdmitInput {
  const request: AdmitInput = {
    from: sender,
    to: peer,
    scopeId: "team",
    message: { id: id(index), kind, format: "text", content: "work" },
  };

  if (deliveryBytes !== undefined) {
    request.deliveryBytes = deliveryBytes;
  }

  return request;
}

function stock() {
  let now = 0;

  const state = createState({
    peer,
    scopeIds: ["team"],
    clock: () => now,
    authorize: () => true,
    offer: () => true,
  });

  const retire = (input: AdmitInput) =>
    state.retire(scopedMessageKey(input.from, input.to, input.scopeId, input.message.id));

  return {
    state,
    retire,
    clock: (value: number) => {
      now = value;
    },
  };
}

describe("README default limits, without overriding any", () => {
  test("the stock limits are the documented numbers", () => {
    expect(defaults).toStrictEqual({
      inboxMessages: 64,
      inboxBytes: 1_048_576,
      receipts: 1024,
      relations: 256,
      recipientsPerWork: 8,
      receiptTtlMs: 600_000,
      relationTtlMs: 86_400_000,
    });
  });
  test("the inbox holds 64 messages and refuses the 65th", () => {
    const { state } = stock();

    for (let index = 1; index <= 64; index += 1) {
      expect(state.admit(incoming(index, "update")).tag).toBe("admitted");
    }

    expect(state.admit(incoming(65, "update"))).toMatchObject({
      tag: "not_admitted",
      code: "overloaded",
      resource: "inbox",
    });
  });
  test("the inbox holds 1 MiB of frames and refuses the next, though far fewer than 64 messages are held", () => {
    const { state } = stock();

    for (let index = 1; index <= 32; index += 1) {
      expect(state.admit(incoming(index, "update", 32_768)).tag).toBe("admitted");
    }

    expect(state.stats()).toMatchObject({ inboxMessages: 32, inboxBytes: 1_048_576 });
    expect(state.admit(incoming(33, "update"))).toMatchObject({
      tag: "not_admitted",
      code: "overloaded",
      resource: "inbox",
    });
  });
  test("1,024 receipts are kept and the 1,025th message is refused", () => {
    const { state, retire } = stock();

    for (let index = 1; index <= 1024; index += 1) {
      const input = incoming(index, "update");
      expect(state.admit(input).tag).toBe("admitted");
      retire(input);
    }

    expect(state.stats().receipts).toBe(1024);
    expect(state.admit(incoming(1025, "update"))).toMatchObject({
      tag: "not_admitted",
      code: "overloaded",
      resource: "receipts",
    });
  });
  test("a receipt is kept for ten minutes after admission", () => {
    const { state, retire, clock } = stock();
    const input = incoming(1, "update");
    state.admit(input);
    retire(input);
    clock(599_999);
    expect(state.stats().receipts).toBe(1);
    clock(600_000);
    expect(state.stats().receipts).toBe(0);
  });
  test("256 relations are kept and the 257th request is refused", () => {
    const { state, retire } = stock();

    for (let index = 1; index <= 256; index += 1) {
      const input = incoming(index, "request");
      expect(state.admit(input).tag).toBe("admitted");
      retire(input);
    }

    expect(state.stats().relations).toBe(256);
    expect(state.admit(incoming(257, "request"))).toMatchObject({
      tag: "not_admitted",
      code: "overloaded",
      resource: "relations",
    });
  });
});
