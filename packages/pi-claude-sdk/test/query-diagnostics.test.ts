import { describe, expect, test } from "vitest";
import type { ModelUsage } from "../sdk/messages";
import { queryDiagnostics } from "../sdk/query-diagnostics";

function diagnostic(modelUsage: ModelUsage, apiError?: string) {
  return queryDiagnostics({
    outcome: "completed",
    numTurns: 3,
    modelUsage,
    ...(apiError === undefined ? {} : { apiError }),
    assistantToolUses: 4,
    maxAssistantToolUses: 2,
    errorToolResults: 1,
    hookDeniedCalls: 2,
    invalidGatewayCalls: 1,
    unexpectedToolCalls: 1,
    fallbackCalls: 0,
  });
}

describe("safe query diagnostics", () => {
  test("exposes all-query-pipeline prompt totals separately by model, without merging main-loop usage", () => {
    expect(
      diagnostic({
        sonnet: {
          canonicalModel: "claude-sonnet-5-5",
          inputTokens: 20,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 30,
        },
        "claude-haiku-4-5-20251001": {
          inputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 40,
        },
      }),
    ).toMatchObject({
      numTurns: 3,
      models: [
        {
          model: "sonnet",
          canonicalModel: "claude-sonnet-5-5",
          input: 20,
          cacheRead: 100,
          cacheWrite: 30,
          promptTokens: 150,
        },
        { model: "claude-haiku-4-5", input: 10, cacheRead: 0, cacheWrite: 40, promptTokens: 50 },
      ],
      modelEntriesOmitted: 0,
    });
  });

  test("bounds model records and replaces unknown custom names with nonpersistent positional labels", () => {
    const usage = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `private route ${index}`,
        { canonicalModel: "private canonical", inputTokens: index },
      ]),
    );
    const result = diagnostic(usage, "private error");
    expect(result.models).toHaveLength(8);
    expect(result.models.map(({ model }) => model)).toStrictEqual(
      Array.from({ length: 8 }, (_, i) => `unknown-${i + 1}`),
    );
    expect(result.modelEntriesOmitted).toBe(92);
    expect(result).not.toHaveProperty("apiError");
    expect(JSON.stringify(result)).not.toContain("private");
  });

  test("never invents a prompt sum from partial, unsafe, fractional or overflowing counts", () => {
    expect(
      diagnostic({
        sonnet: { inputTokens: 5 },
        haiku: { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        opus: { inputTokens: Number.NaN, cacheReadInputTokens: -1, cacheCreationInputTokens: 1.5 },
        fable: {
          inputTokens: Number.MAX_SAFE_INTEGER,
          cacheReadInputTokens: 1,
          cacheCreationInputTokens: 0,
        },
      }).models,
    ).toStrictEqual([
      { model: "sonnet", input: 5 },
      { model: "haiku", input: 0, cacheRead: 0, cacheWrite: 0, promptTokens: 0 },
      { model: "opus" },
      { model: "fable", input: Number.MAX_SAFE_INTEGER, cacheRead: 1, cacheWrite: 0 },
    ]);
  });

  test("retains only the typed API error vocabulary", () => {
    expect(diagnostic({}, "authentication_failed").apiError).toBe("authentication_failed");
    expect(diagnostic({}, "rate_limit").apiError).toBe("rate_limit");
  });
});
