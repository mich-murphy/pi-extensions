import { describe, expect, test } from "vitest";
import { expectNoLeak, observableText } from "./leaks";

describe("expectNoLeak", () => {
  test("sees a raw cause that JSON.stringify renders as nothing", () => {
    const error = new Error("safe", { cause: new Error("SECRET-cause") });
    expect(JSON.stringify(error)).toBe("{}");
    expect(observableText(error)).toContain("SECRET-cause");
    expect(() => {
      expectNoLeak(error, "SECRET-cause");
    }).toThrow("leaked");
  });

  test("sees secrets in messages, non-enumerable properties and nested causes", () => {
    const hidden = Object.defineProperty(new Error("safe"), "detail", {
      value: "SECRET-hidden",
      enumerable: false,
    });
    const nested = { outer: { cause: new Error("x", { cause: new Error("SECRET-deep") }) } };
    expect(observableText(hidden)).toContain("SECRET-hidden");
    expect(observableText(nested)).toContain("SECRET-deep");
    expect(observableText(new Error("SECRET-message"))).toContain("SECRET-message");
  });

  test("passes a value carrying none of the fragments, even with a cycle", () => {
    const value: { self?: unknown; reason: string } = { reason: "invalid" };
    value.self = value;
    expect(() => {
      expectNoLeak(value, "SECRET");
    }).not.toThrow();
  });

  test("sees secrets held in numbers, Map and Set entries, and Symbol-keyed properties", () => {
    expect(observableText(31_337)).toContain("31337");
    expect(observableText(true)).toContain("true");
    expect(observableText(10n)).toContain("10");
    expect(observableText(new Map([["k", "SECRET-map"]]))).toContain("SECRET-map");
    expect(observableText(new Set(["SECRET-set"]))).toContain("SECRET-set");
    expect(observableText({ [Symbol("tag")]: "SECRET-symbol" })).toContain("SECRET-symbol");
  });

  test("stops descending past the depth limit instead of recursing forever", () => {
    let deep: object = { leaf: "SECRET-leaf" };
    for (let level = 0; level < 40; level += 1) {
      deep = { next: deep };
    }
    expect(() => observableText(deep)).not.toThrow();
  });
});
