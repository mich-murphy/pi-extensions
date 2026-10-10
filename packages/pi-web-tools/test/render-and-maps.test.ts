import { Redacted } from "effect";
import { describe, expect, test } from "vitest";
import { appendExpandedPreview, appendExpandHint, getTextContent } from "../render";
import { redactSecrets } from "../tool-output";

describe("redacted", () => {
  test("hides values from string, JSON, and inspect projections", () => {
    const secret = Redacted.make("super-secret");
    // oxlint-disable-next-line typescript/no-base-to-string -- Redacted overrides toString at runtime; this asserts it.
    expect(String(secret)).toBe("<redacted>");
    expect(JSON.stringify(secret)).toBe('"<redacted>"');
    expect(Redacted.value(secret)).toBe("super-secret");
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
    const output = appendExpandedPreview("base", { text, theme, maxLines: 3, maxColumns: 5 });
    expect(output).toContain("line ");
    expect(output.split("\n")).toHaveLength(5); // base + 3 preview lines + ellipsis
  });

  test("appendExpandHint leaves expanded output untouched", () => {
    expect(appendExpandHint("base", true)).toBe("base");
  });
});
