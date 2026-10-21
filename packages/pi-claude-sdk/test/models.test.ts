import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { formatModelStatus, minimumCacheableTokensFor, models, providerModel } from "../models";
import { modelFixture } from "./fixtures";

describe("model table", () => {
  test("routes every registered model through a distinct selector", () => {
    const selectors = models.map((model) => model.sdkModel);

    expect(new Set(selectors).size).toBe(selectors.length);
  });

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
      "claude-5.1-fable": ["minimal", ...adaptive],
      "claude-5.5-haiku": adaptive,
      "claude-4.5-haiku": ["off", "minimal", "low", "medium", "high"],
    });
  });

  test("declares SDK-reported model limits and zero subscription costs", () => {
    expect(
      models.map(({ id, contextWindow, maxTokens }) => ({ id, contextWindow, maxTokens })),
    ).toStrictEqual([
      { id: "claude-5.5-sonnet", contextWindow: 1_000_000, maxTokens: 128_000 },
      { id: "claude-5.5-opus", contextWindow: 1_000_000, maxTokens: 128_000 },
      { id: "claude-5.1-fable", contextWindow: 1_000_000, maxTokens: 64_000 },
      { id: "claude-5.5-haiku", contextWindow: 1_000_000, maxTokens: 128_000 },
      { id: "claude-4.5-haiku", contextWindow: 200_000, maxTokens: 32_000 },
    ]);
    for (const model of models) {
      expect(model.cost).toStrictEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(model.reasoning).toBe(true);
    }
  });

  test("declares image input support on every model so Pi's read tool attaches images instead of omitting them", () => {
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.input).toStrictEqual(["text", "image"]);
    }
  });
});

describe("cache minimum model metadata", () => {
  test.each([
    ["claude-5.5-sonnet", "sonnet", "claude-sonnet-5-5", 512],
    ["claude-5.5-opus", "opus", "claude-opus-5-5", 512],
    ["claude-5.1-fable", "fable", "claude-fable-5-1", 512],
    ["claude-5.5-haiku", "haiku", "claude-haiku-5-5", 512],
    ["claude-4.5-haiku", "claude-haiku-4-5", "claude-haiku-4-5", 4096],
  ] as const)(
    "resolves %s by advertised ID, selector and concrete snapshot",
    (id, alias, canonical, minimum) => {
      const entry = models.find((model) => model.id === id);
      expect(entry?.minimumCacheableTokens).toBe(minimum);
      for (const name of [id, alias, canonical, `${canonical}-20261001`]) {
        expect(minimumCacheableTokensFor(name)).toBe(minimum);
        expect(minimumCacheableTokensFor(`claude-sdk/${name}`)).toBe(minimum);
      }
    },
  );

  test.each([
    ["claude-sonnet-4-5-20250929", 1024],
    ["claude-opus-4-5", 4096],
    ["claude-opus-4-6", 4096],
    ["claude-opus-4-7", 2048],
    ["claude-opus-4-8", 1024],
    ["claude-opus-5", 512],
    ["claude-3-5-haiku-20241022", 2048],
  ] as const)(
    "preserves documented nonuniform minimum for custom concrete model %s",
    (id, minimum) => {
      expect(minimumCacheableTokensFor(id)).toBe(minimum);
    },
  );

  test.each([
    "custom",
    "claude-haiku-6",
    "claude-opus-4-9",
    "claude-sonnet-5-5-custom",
    "anthropic/claude-haiku-4-5",
    "toString",
    "constructor",
    "__proto__",
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
        ["fable", "claude-fable-5-1"],
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
        "  claude-5.1-fable → fable → claude-fable-5-1",
        "  claude-5.5-haiku → haiku → claude-haiku-4-5-20251001 (expected claude-haiku-5-5)",
        "  claude-4.5-haiku → claude-haiku-4-5 → claude-haiku-4-5-20251001",
      ].join("\n"),
    );
  });
});
