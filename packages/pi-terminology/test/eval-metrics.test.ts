import { describe, expect, test } from "vitest";
import {
  computeMetrics,
  meetsUsefulnessGate,
  scoreSets,
  summarizeLatency,
  wilson,
} from "../eval-metrics";
import type { EvalFixture, EvalObservation } from "../eval-metrics";

const fixtures: EvalFixture[] = [
  { id: "a", prompt: "p", applicable: ["x", "y"], displayed: ["x", "y"] },
  { id: "b", prompt: "p", applicable: ["z"], displayed: [] },
  { id: "c", prompt: "p", applicable: [], displayed: ["x"] },
];

function obs(id: string, repeat: number, selected: string[], probabilities = {}): EvalObservation {
  return {
    id,
    repeat,
    probabilities,
    selected,
    latencyMs: 10 * (repeat + 1),
    inputTokens: 100,
    outputTokens: 2,
  };
}

const base = [
  obs("a", 0, ["x", "y"], { x: 0.9, y: 0.4, z: 0.1 }),
  obs("b", 0, ["z"], { z: 0.8 }),
  obs("c", 0, [], { x: 0.2 }),
];

describe("computeMetrics", () => {
  test("counts displayed, per-concept, coverage and group rates literally", () => {
    const metrics = computeMetrics(fixtures, base, { threshold: 0.5 });
    expect(metrics.displayed).toMatchObject({ tp: 2, fp: 1, fn: 1 });
    expect(metrics.displayed.precision).toBeCloseTo(2 / 3);
    expect(metrics.displayed.recall).toBeCloseTo(2 / 3);
    expect(metrics.displayed.meetsPrecisionTarget).toBe(false);
    expect(metrics.perConcept.x).toMatchObject({ tp: 1, fp: 0, fn: 1 });
    expect(metrics.perConcept.z).toMatchObject({
      tp: 0,
      fp: 1,
      fn: 0,
      precision: 0,
      recall: null,
    });
    expect(metrics.nonemptyPromptCoverage).toBe(0.5);
    expect(metrics.abstentionRate).toBeCloseTo(1 / 3);
    expect(metrics.anyFalseGroupRate).toBeCloseTo(1 / 3);
    expect(metrics.usage).toStrictEqual({ inputTokens: 300, outputTokens: 6 });
    expect(metrics.latency).toStrictEqual({ count: 3, meanMs: 10, p50Ms: 10, maxMs: 10 });
  });

  test("scores applicability at the probability threshold", () => {
    const metrics = computeMetrics(fixtures, base, { threshold: 0.5 });
    expect(metrics.applicability).toMatchObject({ threshold: 0.5, tp: 2, fp: 0, fn: 1 });
  });

  test("accepts a point estimate of at least 95 percent when the run is clean", () => {
    const perfect = [obs("a", 0, ["x", "y"]), obs("b", 0, []), obs("c", 0, ["x"])];
    const metrics = computeMetrics(fixtures, perfect, { threshold: 0.5 });
    expect(metrics.displayed.precision).toBe(1);
    expect(metrics.displayed.meetsPrecisionTarget).toBe(true);
    expect(metrics.displayed.precisionWilson95?.[0]).toBeLessThan(1);
  });

  test("an error or missing attempt blocks acceptance and is not an empty success", () => {
    const perfect = [obs("a", 0, ["x", "y"]), obs("b", 0, [])];
    const failed = computeMetrics(fixtures, perfect, {
      threshold: 0.5,
      errors: [{ id: "c", repeat: 0, message: "timeout" }],
    });
    expect(failed).toMatchObject({ errors: 1, attempts: 2, missingAttempts: 0 });
    expect(failed.displayed.meetsPrecisionTarget).toBe(false);
    const short = computeMetrics(fixtures, perfect, { threshold: 0.5, expectedAttempts: 3 });
    expect(short.missingAttempts).toBe(1);
    expect(short.displayed.meetsPrecisionTarget).toBe(false);
  });

  test("empty selection reports null precision and fails acceptance", () => {
    const metrics = computeMetrics(fixtures, [obs("b", 0, [])], { threshold: 0.5 });
    expect(metrics.displayed).toMatchObject({
      precision: null,
      precisionWilson95: null,
      meetsPrecisionTarget: false,
    });
    expect(computeMetrics(fixtures, [], { threshold: 0.5 }).abstentionRate).toBeNull();
  });

  test("repeats add attempts and flips, not prompts", () => {
    const repeated = [...base, obs("a", 1, ["x"]), obs("b", 1, ["z"])];
    const metrics = computeMetrics(fixtures, repeated, { threshold: 0.5 });
    expect(metrics).toMatchObject({ prompts: 3, attempts: 5 });
    expect(metrics.flips).toStrictEqual({ repeatedPrompts: 2, unstablePrompts: 1 });
  });

  test.each([
    [[obs("nope", 0, [])], "matches no fixture"],
    [[obs("a", 0, []), obs("a", 0, [])], "Duplicate"],
  ])("rejects inconsistent observations %#", (observations, message) => {
    expect(() => computeMetrics(fixtures, observations, { threshold: 0.5 })).toThrow(message);
  });

  test("rejects duplicate fixture ids", () => {
    expect(() =>
      computeMetrics([...fixtures, ...fixtures.slice(0, 1)], [], { threshold: 0.5 }),
    ).toThrow("unique");
  });
});

describe("helpers", () => {
  test("scoreSets counts overlap", () => {
    expect(scoreSets(new Set(["a", "b"]), new Set(["b", "c"]))).toStrictEqual({
      tp: 1,
      fp: 1,
      fn: 1,
    });
  });

  test("wilson interval brackets the estimate", () => {
    expect(wilson(0, 0)).toBeNull();
    const interval = wilson(9, 10);
    expect(interval?.[0]).toBeCloseTo(0.5958, 3);
    expect(interval?.[1]).toBeCloseTo(0.9821, 3);
  });

  test("latency summary handles empty and even counts", () => {
    expect(summarizeLatency([])).toStrictEqual({
      count: 0,
      meanMs: null,
      p50Ms: null,
      maxMs: null,
    });
    expect(summarizeLatency([40, 10, 20, 30])).toStrictEqual({
      count: 4,
      meanMs: 25,
      p50Ms: 20,
      maxMs: 40,
    });
  });
});

describe("round-two usefulness gate", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const records = ids.map((id) => ({ id, prompt: id, applicable: [id], displayed: [id] }));
  const observations = ids.map((id) => obs(id, 0, [id]));
  const passing = computeMetrics(records, observations, { threshold: 0.5, expectedAttempts: 6 });
  test("requires all six concepts with nonzero expected positives and at least half recalled", () => {
    expect(meetsUsefulnessGate(passing, ids)).toBe(true);
    expect(meetsUsefulnessGate(passing, ids.slice(1))).toBe(false);
    expect(meetsUsefulnessGate(passing, ["a", "a", "b", "c", "d", "e"])).toBe(false);
    expect(meetsUsefulnessGate(passing, ["a", "b", "c", "d", "e", "missing"])).toBe(false);
    const incomplete = computeMetrics(records, observations.slice(1), {
      threshold: 0.5,
      expectedAttempts: 6,
    });
    expect(meetsUsefulnessGate(incomplete, ids)).toBe(false);
    expect(
      meetsUsefulnessGate(
        {
          ...passing,
          perConcept: {
            ...passing.perConcept,
            a: { tp: 0, fp: 0, fn: 0, precision: null, recall: null },
          },
        },
        ids,
      ),
    ).toBe(false);
    expect(
      meetsUsefulnessGate(
        {
          ...passing,
          perConcept: {
            ...passing.perConcept,
            a: { tp: 1, fp: 0, fn: 2, precision: 1, recall: 1 / 3 },
          },
        },
        ids,
      ),
    ).toBe(false);
    expect(meetsUsefulnessGate({ ...passing, errors: 1 }, ids)).toBe(false);
  });
});
