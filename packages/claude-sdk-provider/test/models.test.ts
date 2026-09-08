import { describe, expect, test } from "vitest";
import { formatModelStatus, models, providerModel, undatedModelId } from "../models";

describe("providerModel", () => {
  test("strips the routing fields Pi does not know about", () => {
    const [first] = models;
    if (!first) throw new Error("test setup: model table is empty");

    const registered = providerModel(first);

    expect(registered).not.toHaveProperty("sdkModel");
    expect(registered).not.toHaveProperty("canonicalModel");
    expect(registered).toMatchObject({ id: first.id, contextWindow: first.contextWindow });
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
        ["opus", "claude-opus-5-2"],
      ]),
    );

    expect(text).toBe(
      [
        "Models:",
        "  claude-5-sonnet → sonnet → not observed yet",
        "  claude-5-opus → opus → claude-opus-5-2 (expected claude-opus-5)",
        "  claude-5.1-fable → fable → claude-fable-5-1",
        "  claude-4.5-haiku → haiku → claude-haiku-4-5-20251001",
      ].join("\n"),
    );
  });
});
