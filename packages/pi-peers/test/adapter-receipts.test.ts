import { describe, expect, test } from "vitest";
import { SentReceipts } from "../adapter/receipts.js";

describe("sent receipts remember the receiver's durability per message", () => {
  test("records the latest flag and forgets the oldest beyond the limit", () => {
    const receipts = new SentReceipts(2);
    receipts.record("a", false);
    receipts.record("b", true);
    receipts.record("a", true);
    receipts.record("c", false);
    expect(receipts.durableFor("b")).toBeUndefined();
    expect(receipts.durableFor("a")).toBe(true);
    expect(receipts.durableFor("c")).toBe(false);
  });
});
