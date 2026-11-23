import { afterEach, beforeEach, describe, expect, test } from "vitest";

const hooks: string[] = [];

describe("vitest fail-stop cleanup", () => {
  describe("a fixture whose beforeEach refuses after a prior cleanup failure", () => {
    beforeEach(() => {
      hooks.push("beforeEach");
      throw new Error("Prior native cleanup failed; refusing a new fixture");
    });
    afterEach(() => {
      hooks.push("afterEach");
    });
    test.fails("skips the body and fails the test", () => {
      hooks.push("body");
      expect(hooks).toContain("body");
    });
  });
  test("vitest still runs afterEach when the fail-stop beforeEach throws", () => {
    expect(hooks).toStrictEqual(["beforeEach", "afterEach"]);
  });
});
