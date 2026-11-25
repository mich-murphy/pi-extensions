import { describe, expect, test } from "vitest";
import {
  groupId,
  normalizeErrorText,
  reportFingerprint,
  signalFingerprint,
} from "../fingerprint.ts";

describe("normalizeErrorText", () => {
  test("replaces paths, ids, urls and numbers", () => {
    expect(
      normalizeErrorText(
        "ENOENT: access '/private/tmp/x/7e0777d7-a1e1-45c0-8968-e805f55cf491/a.png' after 2.4 s, see https://example.com/a?b=1 at 4757a8f",
      ),
    ).toBe("ENOENT: access '<path>' after <n> s, see <url> at <id>");
  });

  test("gives two scratchpad misses the same text", () => {
    const first = normalizeErrorText(
      "ENOENT: '/tmp/a/0f1e2d3c-0000-4000-8000-000000000001/z5.png'",
    );

    const second = normalizeErrorText(
      "ENOENT: '/tmp/b/9a8b7c6d-0000-4000-8000-000000000002/zr60.png'",
    );

    expect(first).toBe(second);
  });

  test("keeps words that only look like hex", () => {
    expect(normalizeErrorText("deadbeefcafe failed")).toBe("deadbeefcafe failed");
  });

  test("collapses whitespace", () => {
    expect(normalizeErrorText("  a\n\n\tb  ")).toBe("a b");
  });
});

describe("signalFingerprint", () => {
  test("prefixes the tool and caps the text", () => {
    const fingerprint = signalFingerprint("codemode", `Script failed ${"x".repeat(200)}`);
    expect(fingerprint.startsWith("codemode: Script failed ")).toBe(true);
    expect(fingerprint).toHaveLength("codemode: ".length + 96);
  });
});

describe("reportFingerprint", () => {
  test("normalizes the component", () => {
    expect(reportFingerprint("  Pi-Claude \n scratch ", "workaround")).toBe(
      "pi-claude scratch/workaround",
    );
  });
});

describe("groupId", () => {
  test("is twelve hex characters", () => {
    expect(groupId("pi-claude", "read: ENOENT")).toMatch(/^[0-9a-f]{12}$/u);
  });

  test("separates owners with the same fingerprint", () => {
    expect(groupId("pi-claude", "read: ENOENT")).not.toBe(groupId("pi-core", "read: ENOENT"));
  });
});
