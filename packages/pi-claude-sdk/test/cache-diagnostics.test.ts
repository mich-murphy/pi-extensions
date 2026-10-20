import { assert, describe, expect, it, test } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { buildAgentRequest } from "../agent-request";
import { createCacheDiagnosticTracker } from "../cache-tracker";
import type { CacheDiagnostic } from "../cache-tracker";
import { buildPromptStream } from "../sdk/prompt-stream";
import { contextFixture, drain, sdkContentRecords, textBlock } from "./fixtures";

function withoutCacheMetadata(block: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { cache_control: _cacheControl, ...content } = block;
  return content;
}

describe("cache diagnostics", () => {
  test("reports a byte-identical common prefix for long transcripts containing images without logging content", async () => {
    const longOutput = "stable build output\n".repeat(5000);
    const base = contextFixture({
      systemPrompt: "stable system",
      tools: [],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "inspect screenshot" },
            { type: "image", data: "cGl4ZWxz".repeat(2000), mimeType: "image/png" },
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
    const tracker = Effect.runSync(
      createCacheDiagnosticTracker((event) => {
        events.push(event);
      }),
    );

    tracker("claude-sdk/sonnet", first);
    tracker("claude-sdk/sonnet", second);

    const [, secondDiagnostic] = events;
    expect(secondDiagnostic?.type).toBe("request");
    assert(secondDiagnostic?.type === "request", "missing request diagnostic");
    expect(secondDiagnostic.commonPrefixBlocks).toBe(first.promptBlocks.length - 1);
    expect(secondDiagnostic.breakpoints).toStrictEqual(second.cacheBreakpoints);
    expect(secondDiagnostic.prefixChange).toBe("appended");
    expect(secondDiagnostic.commonPrefixCharacters).toBeGreaterThan(100_000);
    expect(secondDiagnostic.imageBase64Characters).toBe(16_000);
    expect(JSON.stringify(secondDiagnostic)).not.toContain("stable build output");
    expect(JSON.stringify(secondDiagnostic)).not.toContain("cGl4ZWxz");

    const firstWire = await drain(buildPromptStream(first.promptBlocks, first.cacheBreakpoints));
    const secondWire = await drain(buildPromptStream(second.promptBlocks, second.cacheBreakpoints));
    const firstContent = sdkContentRecords(firstWire[0]);
    const secondContent = sdkContentRecords(secondWire[0]);
    const sharedPrefix = secondContent
      .slice(0, firstContent.length - 1)
      .map((block) => withoutCacheMetadata(block));
    expect(sharedPrefix).toStrictEqual(
      firstContent.slice(0, -1).map((block) => withoutCacheMetadata(block)),
    );
  });

  test("fingerprints equal prompts equally and a changed block differently", () => {
    const events: CacheDiagnostic[] = [];
    const tracker = Effect.runSync(
      createCacheDiagnosticTracker((event) => {
        events.push(event);
      }),
    );
    const prompt = {
      promptBlocks: [textBlock("stable"), textBlock("first")],
      cacheBreakpoints: [0],
    };

    tracker("claude-sdk/sonnet", prompt);
    tracker("claude-sdk/sonnet", prompt);
    tracker("claude-sdk/sonnet", {
      ...prompt,
      promptBlocks: [textBlock("stable"), textBlock("x")],
    });

    const [first, repeated, changed] = events;
    assert(first?.type === "request", "missing first request diagnostic");
    assert(repeated?.type === "request", "missing repeated request diagnostic");
    assert(changed?.type === "request", "missing changed request diagnostic");
    expect(repeated.contentFingerprint).toBe(first.contentFingerprint);
    expect(repeated.commonPrefixBlocks).toBe(2);
    expect(changed.contentFingerprint).not.toBe(first.contentFingerprint);
    expect(changed.reusablePrefixFingerprint).toBe(first.reusablePrefixFingerprint);
    expect(changed.commonPrefixBlocks).toBe(1);
  });

  test("flags a large low-reuse turn as a possible cache collapse", () => {
    const events: CacheDiagnostic[] = [];
    const tracker = Effect.runSync(
      createCacheDiagnosticTracker((event) => {
        events.push(event);
      }),
    );
    const recordUsage = tracker("claude-sdk/sonnet", {
      promptBlocks: [textBlock("x".repeat(100_000))],
      cacheBreakpoints: [0],
    });
    recordUsage({ input: 94_337, output: 100, cacheRead: 27_165, cacheWrite: 0 });

    expect(events[1]).toMatchObject({
      type: "usage",
      promptTokens: 121_502,
      cacheReadPercent: 22.36,
      possibleCollapse: true,
    });
  });

  it.effect("measures the gap between requests with the Clock in scope", () =>
    Effect.gen(function* () {
      const events: CacheDiagnostic[] = [];
      const prompt = { promptBlocks: [textBlock("stable")], cacheBreakpoints: [0] };

      const tracker = yield* createCacheDiagnosticTracker((event) => {
        events.push(event);
      });
      tracker("claude-sdk/sonnet", prompt);
      yield* TestClock.adjust("5 seconds");
      tracker("claude-sdk/sonnet", prompt);

      expect(events[0]).not.toHaveProperty("msSincePreviousRequest");
      expect(events[1]).toMatchObject({ type: "request", turn: 2, msSincePreviousRequest: 5000 });
    }),
  );

  it.effect("classifies prefix changes and the likely cause of a low cache read", () =>
    Effect.gen(function* () {
      const events: CacheDiagnostic[] = [];
      const tracker = yield* createCacheDiagnosticTracker((event) => {
        events.push(event);
      });
      const base = {
        promptBlocks: [textBlock("system"), textBlock("x".repeat(8000)), textBlock("continue")],
        cacheBreakpoints: [0, 1],
        toolDescription: "tools",
      };
      const otherTools = { ...base, toolDescription: "other tools" };
      const otherSystem = {
        ...otherTools,
        promptBlocks: [textBlock("changed"), ...base.promptBlocks.slice(1)],
      };
      const miss = { input: 3000, output: 1, cacheRead: 0, cacheWrite: 0 };

      tracker("m", base)(miss);
      yield* TestClock.adjust("2 hours");
      tracker("m", base)(miss);
      tracker("m", otherTools)(miss);
      tracker("m", otherSystem)(miss);
      tracker("m", otherSystem, { reasoning: "high" })(miss);
      tracker("m", otherSystem, { reasoning: "high", ttl: "none" })(miss);
      tracker("m", otherSystem, { reasoning: "high" })({ ...miss, input: 10 });
      tracker("other", otherSystem, { reasoning: "high" })({ ...miss, cacheRead: 9000 });

      expect(
        events.flatMap((event) => (event.type === "request" ? [event.prefixChange] : [])),
      ).toStrictEqual([
        "first",
        "appended",
        "tools-changed",
        "system-changed",
        "reasoning-changed",
        "appended",
        "appended",
        "model-changed",
      ]);
      expect(
        events.flatMap((event) => (event.type === "usage" ? [event.likelyMissCause] : [])),
      ).toStrictEqual([
        "first",
        "ttl-expired",
        "prefix-changed",
        "prefix-changed",
        "prefix-changed",
        "caching-disabled",
        "below-minimum",
        undefined,
      ]);
      expect(events[2]).toMatchObject({ type: "request", ttl: "5m", breakpoints: [0, 1] });
    }),
  );

  test("attributes a low read to the lookback window when no breakpoint reaches the previous write", () => {
    const events: CacheDiagnostic[] = [];
    const tracker = Effect.runSync(
      createCacheDiagnosticTracker((event) => {
        events.push(event);
      }),
    );
    const entries = Array.from({ length: 30 }, (_, index) => textBlock(`entry ${index}`));
    tracker("m", { promptBlocks: [textBlock("system"), textBlock("tail")], cacheBreakpoints: [1] });
    tracker("m", {
      promptBlocks: [textBlock("system"), textBlock("tail"), ...entries],
      cacheBreakpoints: [31],
    })({ input: 5000, output: 1, cacheRead: 0, cacheWrite: 0 });

    expect(events.at(-1)).toMatchObject({ type: "usage", likelyMissCause: "lookback" });
  });
});
