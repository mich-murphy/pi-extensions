import { describe, expect, test } from "vitest";
import { validateBoundReply } from "../adapter/replies.js";

const self = { machineId: "local", sessionId: "session", runtimeNonce: "a".repeat(32) };
const request = {
  v: 1,
  op: "gateway.restart",
  rid: "b".repeat(32),
  expectedMachineId: "local",
} as const;
const reply = {
  v: 1,
  op: "result",
  rid: request.rid,
  forOp: "gateway.restart",
  outcome: { tag: "ok", value: {} },
} as const;

describe("local maintenance reply binding", () => {
  test("accepts a structurally validated restart acknowledgment for its exact operation", () => {
    expect(() => {
      validateBoundReply(request, reply, self);
    }).not.toThrow();
  });

  test("rejects a different operation's acknowledgment for a restart request", () => {
    expect(() => {
      validateBoundReply(request, { ...reply, forOp: "close" }, self);
    }).toThrow("Operation binding mismatch");
  });

  test("cannot substitute a restart acknowledgment for an ordinary close request", () => {
    expect(() => {
      validateBoundReply({ v: 1, op: "close", rid: request.rid }, reply, self);
    }).toThrow("Operation binding mismatch");
  });
});
