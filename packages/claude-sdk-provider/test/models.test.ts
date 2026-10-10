import { assert, describe, expect, test } from "vitest";
import { formatModelStatus, models, providerModel, undatedModelId } from "../models";

describe("providerModel", () => {
  test("strips the routing fields Pi does not know about", () => {
    const [first] = models;
    assert(first !== undefined, "test setup: model table is empty");

    const registered = providerModel(first);

    expect(registered).not.toHaveProperty("sdkModel");
    expect(registered).not.toHaveProperty("canonicalModel");
    expect(registered).toMatchObject({ id: first.id, contextWindow: first.contextWindow });
  });
});

describe("model table", () => {
  test("registers Sonnet 5.5 through the moving alias with its limits", () => {
    expect(models.find((model) => model.id === "claude-5.5-sonnet")).toMatchObject({
      name: "Claude Sonnet 5.5 (official Agent SDK)",
      sdkModel: "sonnet",
      canonicalModel: "claude-sonnet-5-5",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
  });

  test("registers Haiku 5.5 through the moving alias with effort-based reasoning and its limits", () => {
    expect(models.find((model) => model.id === "claude-5.5-haiku")).toMatchObject({
      name: "Claude Haiku 5.5 (official Agent SDK)",
      sdkModel: "haiku",
      canonicalModel: "claude-haiku-5-5",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
  });

  test("pins Haiku 4.5 to its full model ID, since the haiku alias now resolves to Haiku 5.5", () => {
    expect(models.find((model) => model.id === "claude-4.5-haiku")).toMatchObject({
      name: "Claude Haiku 4.5 (official Agent SDK)",
      sdkModel: "claude-haiku-4-5",
      canonicalModel: "claude-haiku-4-5",
      reasoning: false,
      contextWindow: 200_000,
      maxTokens: 64_000,
    });
  });

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

describe("undatedModelId", () => {
  test("drops a trailing snapshot date and leaves other ids alone", () => {
    expect(undatedModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(undatedModelId("claude-fable-5-1")).toBe("claude-fable-5-1");
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
