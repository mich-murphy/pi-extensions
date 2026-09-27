import { describe, expect, test } from "vitest";
import { Redacted, redactSecrets } from "../redacted";
import { appendExpandedPreview, appendExpandHint, getTextContent } from "../render";

describe("Redacted", () => {
  test("hides values from string, JSON, and inspect projections", () => {
    const secret = Redacted.make("super-secret");
    expect(String(secret)).toBe("<redacted>");
    expect(JSON.stringify(secret)).toBe('"<redacted>"');
    expect(Redacted.value(secret)).toBe("super-secret");
  });

  test("rejects foreign objects", () => {
    expect(() => Redacted.value({})).toThrow("not in registry");
  });
});

describe("redactSecrets", () => {
  test("replaces every occurrence and skips unset secrets", () => {
    expect(redactSecrets("key=abc use abc twice", ["abc", undefined])).toBe(
      "key=[redacted] use [redacted] twice",
    );
  });
});

const theme = { fg: (_name: string, value: string) => value };

describe("render helpers", () => {
  test("getTextContent joins text items", () => {
    expect(
      getTextContent([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]),
    ).toBe("a\nb");
    expect(getTextContent(undefined)).toBe("");
  });

  test("appendExpandedPreview caps lines and columns", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const output = appendExpandedPreview("base", text, theme, { maxLines: 3, maxColumns: 5 });
    expect(output).toContain("line ");
    expect(output.split("\n")).toHaveLength(5); // base + 3 preview lines + ellipsis
  });

  test("appendExpandHint leaves expanded output untouched", () => {
    expect(appendExpandHint("base", true)).toBe("base");
  });
});
