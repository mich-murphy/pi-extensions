import { describe, expect, test } from "vitest";
import { buildAgentRequest } from "../agent-request";
import { cacheDiagnosticsFromEnvironment } from "../cache-diagnostics";
import { type CacheDiagnostic, createCacheDiagnosticTracker } from "../cache-tracker";
import { buildPromptStream } from "../sdk/prompt-stream";
import { contextFixture, drain, sdkContentRecords, textBlock } from "./fixtures";

describe("cache diagnostics", () => {
  test("reports a byte-identical common prefix for long transcripts containing images without logging content", async () => {
    const longOutput = "stable build output\n".repeat(5_000);
    const base = contextFixture({
      systemPrompt: "stable system",
      tools: [],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "inspect screenshot" },
            { type: "image", data: "cGl4ZWxz".repeat(2_000), mimeType: "image/png" },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: longOutput }],
        },
      ],
    });
    const grown = contextFixture({
      ...base,
      messages: [...base.messages, { role: "user", content: "continue" }],
    });
    const first = buildAgentRequest(base);
    const second = buildAgentRequest(grown);
    const events: CacheDiagnostic[] = [];
    const tracker = createCacheDiagnosticTracker((event) => events.push(event));

    tracker("claude-sdk/sonnet", first);
    tracker("claude-sdk/sonnet", second);

    const secondDiagnostic = events[1];
    expect(secondDiagnostic?.type).toBe("request");
    if (secondDiagnostic?.type !== "request") throw new Error("missing request diagnostic");
    expect(secondDiagnostic.commonPrefixBlocks).toBe(first.promptBlocks.length - 1);
    expect(secondDiagnostic.breakpointBlock).toBe(second.cacheBreakpoint);
    expect(secondDiagnostic.commonPrefixCharacters).toBeGreaterThan(100_000);
    expect(secondDiagnostic.imageBase64Characters).toBe(16_000);
    expect(JSON.stringify(secondDiagnostic)).not.toContain("stable build output");
    expect(JSON.stringify(secondDiagnostic)).not.toContain("cGl4ZWxz");

    const firstWire = await drain(buildPromptStream(first.promptBlocks, first.cacheBreakpoint));
    const secondWire = await drain(buildPromptStream(second.promptBlocks, second.cacheBreakpoint));
    const firstContent = sdkContentRecords(firstWire[0]);
    const secondContent = sdkContentRecords(secondWire[0]);
    const withoutCacheMetadata = (block: Record<string, unknown>) => {
      const { cache_control: _cacheControl, ...content } = block;
      return content;
    };
    expect(secondContent.slice(0, firstContent.length - 1).map(withoutCacheMetadata)).toEqual(
      firstContent.slice(0, -1).map(withoutCacheMetadata),
    );
  });

  test("reports wall-clock gap since the previous request so TTL-expiry misses are distinguishable in logs", () => {
    const events: CacheDiagnostic[] = [];
    const tracker = createCacheDiagnosticTracker((event) => events.push(event));

    tracker("claude-sdk/sonnet", { promptBlocks: [textBlock("first")], cacheBreakpoint: 0 });
    tracker("claude-sdk/sonnet", {
      promptBlocks: [textBlock("first"), textBlock("second")],
      cacheBreakpoint: 1,
    });

    const [first, second] = events;
    if (first?.type !== "request" || second?.type !== "request")
      throw new Error("missing request diagnostics");
    expect(first.msSincePreviousRequest).toBeUndefined();
    expect(typeof second.msSincePreviousRequest).toBe("number");
    expect(second.msSincePreviousRequest).toBeGreaterThanOrEqual(0);
  });

  test("flags a large low-reuse turn as a possible cache collapse", () => {
    const events: CacheDiagnostic[] = [];
    const tracker = createCacheDiagnosticTracker((event) => events.push(event));
    const recordUsage = tracker("claude-sdk/sonnet", {
      promptBlocks: [textBlock("x".repeat(100_000))],
      cacheBreakpoint: 0,
    });
    recordUsage({ input: 94_337, output: 100, cacheRead: 27_165, cacheWrite: 0 });

    expect(events[1]).toMatchObject({
      type: "usage",
      promptTokens: 121_502,
      cacheReadPercent: 22.36,
      possibleCollapse: true,
    });
  });

  test("is opt-in", () => {
    expect(cacheDiagnosticsFromEnvironment({})).toBeUndefined();
    expect(cacheDiagnosticsFromEnvironment({ PI_CLAUDE_SDK_CACHE_DIAGNOSTICS: "1" })).toBeDefined();
  });
});
