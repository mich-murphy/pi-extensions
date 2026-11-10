import { assert, describe, expect, test } from "vitest";
import { inspectBashCommand, sanitizeBashContent, sanitizeContextMessages } from "../output-safety";

function bashResult(
  toolCallId: string,
  content: readonly { readonly type: "text"; readonly text: string }[],
) {
  return {
    role: "toolResult" as const,
    toolName: "bash",
    toolCallId,
    isError: false,
    content: [...content],
    timestamp: 0,
  };
}

function sanitizedText(messages: Parameters<typeof sanitizeContextMessages>[0], index: number) {
  const message = sanitizeContextMessages(messages)[index];
  if (message?.role !== "toolResult") {
    throw new Error("test setup: expected a tool result");
  }
  expect(message.content).toHaveLength(1);
  const [block] = message.content;
  if (block?.type !== "text") {
    throw new Error("test setup: expected a text notice");
  }
  return block.text;
}

describe("bash output safety", () => {
  test.each([
    "cat $(which plannotator) 2>/dev/null | head -100",
    'cat "$(command -v plannotator)"',
    "cat '$(which plannotator)'",
    "cat `which plannotator`",
    'cat "`command -v plannotator`"',
  ])("blocks executable dumps through supported shell substitutions: %s", (command) => {
    expect(inspectBashCommand(command)).toContain('file "$(which COMMAND)"');
  });

  test("quarantines binary output before it enters the transcript", () => {
    const binary = `Mach-O\u0000\u0001\u0002${"\u0000binary".repeat(5000)}`;
    const result = sanitizeBashContent([{ type: "text", text: binary }]);

    expect(result.detected).toBe("binary");
    const [notice] = result.content;
    expect(notice?.type).toBe("text");
    assert(notice?.type === "text", "missing quarantine notice");
    expect(notice.text).toContain("Binary-like bash output quarantined");
    expect(notice.text.length).toBeLessThan(1000);
    expect(notice.text).toContain("Use file, otool, or strings");
  });

  test("quarantines base64 split across content blocks in live and historical results", () => {
    const splitPayload = ["iVBORw0KGgo", "A".repeat(7000), "B".repeat(7000)].map((text) => ({
      type: "text" as const,
      text,
    }));

    const live = sanitizeBashContent(splitPayload);
    expect(live.detected).toBe("base64");
    const [liveNotice] = live.content;
    assert(liveNotice?.type === "text", "missing live quarantine notice");
    expect(liveNotice.text).toContain("Base64-like bash output quarantined");
    expect(liveNotice.text).not.toContain("AAAA");

    const historical = sanitizedText([bashResult("call-split", splitPayload)], 0);
    expect(historical).toContain("Base64-like bash output quarantined");
    expect(historical).not.toContain("AAAA");
  });
});
