import { describe, expect, test } from "vitest";
import { sanitizeBashContent } from "../output-safety";

function scan(text: string) {
  return sanitizeBashContent([{ type: "text", text }]).detected;
}

describe("suspicious output scan", () => {
  test("long base64 text is quarantined as base64", () => {
    expect(scan("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIz\n".repeat(400))).toBe("base64");
  });

  test("base64 text with one character outside the alphabet is kept", () => {
    expect(scan(`${"QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIz\n".repeat(400)}!`)).toBeUndefined();
  });

  test("control characters among astral text are counted as binary", () => {
    expect(scan(`${"\0".repeat(10)}${"🚀 text\n".repeat(600)}`)).toBe("binary");
  });

  test("replacement characters are counted as binary", () => {
    expect(scan(`${"�".repeat(10)}${"plain\n".repeat(700)}`)).toBe("binary");
  });

  test("tabs, newlines and carriage returns are not control characters", () => {
    expect(scan("a\tb\r\n".repeat(2000))).toBeUndefined();
  });
});
