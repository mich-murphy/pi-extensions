import { describe, expect, test } from "vitest";
import { formatModelStatus, models } from "../models";

describe("model table", () => {
  test("routes every registered model through a distinct selector", () => {
    const selectors = models.map((model) => model.sdkModel);

    expect(new Set(selectors).size).toBe(selectors.length);
  });

  test("declares image input support on every model so Pi's read tool attaches images instead of omitting them", () => {
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.input).toStrictEqual(["text", "image"]);
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
