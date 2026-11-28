import { describe, expect, test } from "vitest";
import { errnoCode } from "../errno";

describe("errnoCode", () => {
  test.each([
    { error: Object.assign(new Error("missing file"), { code: "ENOENT" }), code: "ENOENT" },
    { error: Object.assign(new Error("non-string code"), { code: 1 }), code: undefined },
    { error: { code: "ENOENT" }, code: undefined },
  ])("reads a string code only from an Error ($error)", ({ error, code }) => {
    expect(errnoCode(error)).toBe(code);
  });
});
