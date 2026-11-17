import assert from "node:assert/strict";
import { Hegel } from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { Result } from "effect";
import { describe, test } from "vitest";
import { propertySettings } from "../../../test-support/hegel-settings";
import { applyUsage, contextWindowFor, maxOutputTokensFor, parseSdkMessage } from "../sdk/messages";
import type { ReportedUsage } from "../sdk/messages";
import { resultMessage } from "./fixtures";

const settings = propertySettings(200);
const COUNT_KEYS = [
  ["input_tokens", "input"],
  ["output_tokens", "output"],
  ["cache_read_input_tokens", "cacheRead"],
  ["cache_creation_input_tokens", "cacheWrite"],
] as const;
const INVALID_LIMITS = [null, 0, -1, 1.5, "64000", Number.NaN, Number.POSITIVE_INFINITY];

const count = gs.optional(gs.integers({ minValue: 0, maxValue: 6 }));
const maybeCount = gs.oneOf(count, gs.just(undefined));

function lastReported(values: readonly (number | null | undefined)[]): number | undefined {
  return values.findLast((value) => typeof value === "number");
}

function drawReport(tc: TestCase): ReportedUsage {
  const creation = tc.draw(
    gs.oneOf(
      gs.just(undefined),
      gs.composite((inner) => ({
        ephemeral_1h_input_tokens: inner.draw(maybeCount),
        ephemeral_5m_input_tokens: inner.draw(maybeCount),
      })),
    ),
  );
  return {
    cache_creation: creation,
    input_tokens: tc.draw(maybeCount),
    output_tokens: tc.draw(maybeCount),
    cache_read_input_tokens: tc.draw(maybeCount),
    cache_creation_input_tokens: tc.draw(maybeCount),
  };
}

function creationOf(
  report: ReportedUsage,
  key: "ephemeral_1h_input_tokens" | "ephemeral_5m_input_tokens",
) {
  return report.cache_creation?.[key];
}

function assertUsageFold(tc: TestCase): void {
  const reports = tc.draw(gs.arrays(gs.composite(drawReport), { maxSize: 6 }));
  let folded: ReturnType<typeof applyUsage> | undefined;
  for (const report of reports) {
    folded = applyUsage(folded, report);
  }
  for (const [key, field] of COUNT_KEYS) {
    const expected = lastReported(reports.map((report) => report[key])) ?? 0;
    assert.equal(folded?.[field] ?? 0, expected, field);
  }
  const one = lastReported(reports.map((r) => creationOf(r, "ephemeral_1h_input_tokens")));
  const five = lastReported(reports.map((r) => creationOf(r, "ephemeral_5m_input_tokens")));
  assert.equal(folded?.cacheWrite1h, one);
  assert.equal(folded?.cacheWrite5m, five);
  assert.equal("cacheWrite1h" in (folded ?? {}), one !== undefined);
}

function assertTurnScopeSplit(tc: TestCase): void {
  const before = tc.draw(gs.composite(drawReport));
  const final = tc.draw(gs.composite(drawReport));
  const prior = applyUsage(undefined, before);
  const turn = applyUsage(prior, final, "turn");
  assert.equal(turn.cacheWrite1h, creationOf(final, "ephemeral_1h_input_tokens") ?? undefined);
  assert.equal(turn.cacheWrite5m, creationOf(final, "ephemeral_5m_input_tokens") ?? undefined);
  const expectedWrite = final.cache_creation_input_tokens ?? prior.cacheWrite;
  assert.equal(turn.cacheWrite, expectedWrite);
}

function limitsFor(context: unknown, output: unknown, canonical: string, key: string) {
  const parsed = parseSdkMessage(
    resultMessage({
      modelUsage: {
        [key]: { canonicalModel: canonical, contextWindow: context },
        decoy: { canonicalModel: "claude-decoy-9", maxOutputTokens: 1 },
        alias: { canonicalModel: canonical, maxOutputTokens: output },
        "claude-other-1-20250101": { maxOutputTokens: output },
      },
    }),
  );
  if (Result.isFailure(parsed)) {
    throw parsed.failure;
  }
  assert.equal(parsed.success.type, "result");
  if (parsed.success.type !== "result") {
    throw new Error("unreachable");
  }
  return parsed.success.modelUsage;
}

function validLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function assertLimitLookup(tc: TestCase): void {
  const base = tc.draw(gs.sampledFrom(["claude-haiku-4-5", "claude-fable-5-1", "claude-x-2"]));
  const date = tc.draw(gs.integers({ minValue: 20_200_101, maxValue: 20_991_231 }));
  const good = gs.integers({ minValue: 1, maxValue: 2_000_000 });
  const context = tc.draw(gs.oneOf(good, gs.sampledFrom(INVALID_LIMITS)));
  const output = tc.draw(gs.oneOf(good, gs.sampledFrom(INVALID_LIMITS)));
  const keyDated = tc.draw(gs.booleans());
  const key = keyDated ? `${base}-${date}` : base;
  const modelUsage = limitsFor(context, output, base, key);
  const other = tc.draw(gs.booleans());
  const modelUsage2 = other ? modelUsage : limitsFor(context, output, base, key);
  for (const model of [base, `${base}-${date}`, `${base}-20251001`]) {
    assert.equal(contextWindowFor(modelUsage2, model), validLimit(context), model);
    assert.equal(maxOutputTokensFor(modelUsage2, "claude-other-1"), validLimit(output));
    assert.equal(maxOutputTokensFor(modelUsage2, model), validLimit(output), model);
  }
}

describe("SDK message properties", () => {
  test("usage folding keeps the last reported value per field", () => {
    new Hegel((tc) => {
      assertUsageFold(tc);
    })
      .settings(settings)
      .runSync();
  });

  test("turn totals never inherit a per-call cache-write split", () => {
    new Hegel((tc) => {
      assertTurnScopeSplit(tc);
    })
      .settings(settings)
      .runSync();
  });

  test("limit lookup ignores date suffixes, is independent and rejects invalid values", () => {
    new Hegel((tc) => {
      assertLimitLookup(tc);
    })
      .settings(settings)
      .runSync();
  });
});
