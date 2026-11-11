import { describe, expect, test } from "vitest";
import { diagnosticText } from "../diagnostic-text";
import { ToggleStateMalformed, ToggleStateUnavailable } from "../state";

describe("safe skill-toggle error text", () => {
  test("preserves normal resource labels and local paths", () => {
    expect(diagnosticText('skill "no-comments"')).toBe('skill "no-comments"');
    expect(diagnosticText("/home/me/.pi/agent/pi-skill-toggle.json")).toBe(
      "/home/me/.pi/agent/pi-skill-toggle.json",
    );
  });

  test("bounds names, escapes terminal/bidi controls and omits URLs", () => {
    const text = diagnosticText(
      `https://user:password@example.com/?token=secret \u001b[2J\u202e${"x".repeat(1000)}`,
    );
    expect(text.length).toBeLessThanOrEqual(512);
    expect(text).not.toMatch(/password|secret|\p{Cc}|\p{Bidi_Control}/u);
    expect(text).toContain(String.raw`\u001b`);
    expect(text).toContain(String.raw`\u202e`);
    expect(text.endsWith("...")).toBe(true);
  });

  test("keeps state error classifiers and raw diagnostic fields without reflecting controls", () => {
    const malformed = new ToggleStateMalformed(
      "/tmp/\u001b-state",
      "https://user:password@example.com/",
    );
    expect(malformed._tag).toBe("ToggleStateMalformed");
    expect(malformed.entry).toBe("https://user:password@example.com/");
    expect(malformed.message).not.toMatch(/password|\p{Cc}/u);
    expect(malformed.message).toContain("Fix or remove that entry");
    const unavailable = new ToggleStateUnavailable(
      "load",
      "/tmp/state",
      "EROFS",
      new Error("private cause"),
    );
    expect(unavailable.code).toBe("EROFS");
    expect(unavailable.message).toContain("Use a writable agent directory");
    expect(unavailable.message).not.toContain("private cause");
  });
});
