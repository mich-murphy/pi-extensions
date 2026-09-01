import { describe, expect, test } from "vitest";
import { inspectBashCommand, sanitizeBashContent, sanitizeContextMessages } from "../output-safety";

describe("bash output safety", () => {
  test("blocks the executable-dump pattern that poisoned the investigated session", () => {
    expect(inspectBashCommand("cat $(which plannotator) 2>/dev/null | head -100")).toContain(
      'file "$(which COMMAND)"',
    );
  });

  test("quarantines binary output before it enters the transcript", () => {
    const binary = `Mach-O\u0000\u0001\u0002${"\u0000binary".repeat(5_000)}`;
    const result = sanitizeBashContent([{ type: "text", text: binary }]);

    expect(result.detected).toBe("binary");
    const notice = result.content[0];
    expect(notice?.type).toBe("text");
    if (notice?.type !== "text") throw new Error("missing quarantine notice");
    expect(notice.text).toContain("Binary-like bash output quarantined");
    expect(notice.text.length).toBeLessThan(1_000);
    expect(notice.text).toContain("Use file, otool, or strings");
  });

  test("quarantines long base64 output", () => {
    const base64 = `iVBORw0KGgo${"A".repeat(20_000)}`;
    const result = sanitizeBashContent([{ type: "text", text: base64 }]);

    expect(result.detected).toBe("base64");
    const notice = result.content[0];
    if (notice?.type !== "text") throw new Error("missing quarantine notice");
    expect(notice.text).toContain("Base64-like bash output quarantined");
    expect(notice.text.length).toBeLessThan(1_000);
  });

  test("quarantines base64 split across content blocks in live and historical results", () => {
    const splitPayload = ["iVBORw0KGgo", "A".repeat(7_000), "B".repeat(7_000)].map((text) => ({
      type: "text" as const,
      text,
    }));

    const live = sanitizeBashContent(splitPayload);
    expect(live.detected).toBe("base64");
    const liveNotice = live.content[0];
    if (liveNotice?.type !== "text") throw new Error("missing live quarantine notice");
    expect(liveNotice.text).toContain("Base64-like bash output quarantined");
    expect(liveNotice.text).not.toContain("AAAA");

    const historical = sanitizeContextMessages([
      {
        role: "toolResult",
        toolName: "bash",
        toolCallId: "call-split",
        isError: false,
        content: splitPayload,
      },
    ]);
    // SAFETY: The only fixture entry is a bash result with text content, and this test inspects its sanitized replacement.
    const historicalResult = historical[0] as unknown as {
      content: Array<{ type: string; text: string }>;
    };
    expect(historicalResult.content).toHaveLength(1);
    expect(historicalResult.content[0]?.text).toContain("Base64-like bash output quarantined");
    expect(historicalResult.content[0]?.text).not.toContain("AAAA");
  });

  test("quarantines binary-like output split below the per-block detection threshold", () => {
    const splitPayload = Array.from({ length: 3 }, () => ({
      type: "text" as const,
      text: "\u0000payload".repeat(375),
    }));

    const result = sanitizeBashContent(splitPayload);

    expect(splitPayload.every((block) => block.text.length < 4_096)).toBe(true);
    expect(result.detected).toBe("binary");
    const notice = result.content[0];
    if (notice?.type !== "text") throw new Error("missing quarantine notice");
    expect(notice.text).toContain("Binary-like bash output quarantined");
    expect(notice.text).not.toContain("payload");
  });

  test("leaves normal command output unchanged", () => {
    const content = [{ type: "text" as const, text: "src/index.ts\nREADME.md\n3 files changed" }];
    expect(sanitizeBashContent(content)).toEqual({ content, detected: undefined });
  });

  test("removes already-recorded suspicious bash output from provider context", () => {
    const messages = [
      { role: "user", content: "inspect it" },
      {
        role: "toolResult",
        toolName: "bash",
        toolCallId: "call-1",
        isError: false,
        content: [{ type: "text", text: `header${"\u0000payload".repeat(5_000)}` }],
      },
    ];

    const sanitized = sanitizeContextMessages(messages);
    // SAFETY: The second fixture entry is the bash tool result, and this test only inspects its sanitized text content.
    const toolResult = sanitized[1] as unknown as {
      content: Array<{ type: string; text: string }>;
    };
    expect(toolResult.content[0]?.text).toContain("Binary-like bash output quarantined");
    expect(toolResult.content[0]?.text?.length).toBeLessThan(1_000);
  });
});
