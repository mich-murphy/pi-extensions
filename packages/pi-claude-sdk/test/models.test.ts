import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { formatModelStatus, minimumCacheableTokensFor, models, providerModel } from "../models";
import { modelFixture } from "./fixtures";

describe("model table", () => {
  test("offers the thinking levels each model's effort setting supports, matching Pi's anthropic catalog", () => {
    const levels = Object.fromEntries(
      models.map(({ id, reasoning, thinkingLevelMap }) => [
        id,
        getSupportedThinkingLevels(modelFixture({ id, reasoning, thinkingLevelMap })),
      ]),
    );

    const adaptive = ["low", "medium", "high", "xhigh", "max"];
    expect(levels).toStrictEqual({
      "claude-5.5-sonnet": adaptive,
      "claude-5.5-opus": adaptive,
      "claude-5.2-fable": ["minimal", ...adaptive],
      "claude-5.5-haiku": adaptive,
      "claude-4.5-haiku": ["off", "minimal", "low", "medium", "high"],
    });
  });

  test("declares coherent limits, zero subscription costs and image input", () => {
    for (const model of models) {
      expect(model.maxTokens).toBeLessThan(model.contextWindow);
      expect(model.cost).toStrictEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(model.reasoning).toBe(true);
    }
  });
});

describe("cache minimum model metadata", () => {
  test.each([
    "custom",
    "claude-haiku-6",
    "claude-opus-4-9",
    "claude-sonnet-5-5-custom",
    "anthropic/claude-haiku-4-5",
  ])("does not guess a minimum for %s", (id) => {
    expect(minimumCacheableTokensFor(id)).toBeUndefined();
  });

  test("does not leak SDK-only cache or routing metadata into Pi registration", () => {
    for (const entry of models) {
      const registration = providerModel(entry);
      expect(registration).not.toHaveProperty("minimumCacheableTokens");
      expect(registration).not.toHaveProperty("sdkModel");
      expect(registration).not.toHaveProperty("canonicalModel");
      expect(registration).toMatchObject({ id: entry.id, contextWindow: entry.contextWindow });
    }
  });
});

describe("formatModelStatus", () => {
  test("lists each family with its observation and flags mismatches", () => {
    const text = formatModelStatus(
      new Map([
        ["claude-fable-5-2", "claude-fable-5-2"],
        ["haiku", "claude-haiku-4-5-20251001"],
        ["claude-haiku-4-5", "claude-haiku-4-5-20251001"],
        ["opus", "claude-opus-5-2"],
      ]),
    );

    expect(text).toBe(
      [
        "Models:",
        "  claude-5.5-sonnet → sonnet → not observed yet",
        "  claude-5.5-opus → opus → claude-opus-5-2 (expected claude-opus-5-5)",
        "  claude-5.2-fable → claude-fable-5-2 → claude-fable-5-2",
        "  claude-5.5-haiku → haiku → claude-haiku-4-5-20251001 (expected claude-haiku-5-5)",
        "  claude-4.5-haiku → claude-haiku-4-5 → claude-haiku-4-5-20251001",
      ].join("\n"),
    );
  });
});
