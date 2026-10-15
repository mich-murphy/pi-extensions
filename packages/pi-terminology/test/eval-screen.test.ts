import { describe, expect, test } from "vitest";
import { computeMetrics } from "../eval-metrics";
import { betterScore } from "../scripts/eval-screen";

const metrics = computeMetrics([], [], { threshold: 0.5 });
function score(recall: number, precision: number, threshold: number) {
  return {
    threshold,
    metrics: { ...metrics, displayed: { ...metrics.displayed, recall, precision } },
  };
}

describe("offline threshold ordering", () => {
  test("ranks recall before precision, then precision before threshold", () => {
    expect(betterScore(score(0.8, 0.95, 0.5), score(0.7, 1, 0.99))).toBe(true);
    expect(betterScore(score(0.8, 1, 0.5), score(0.8, 0.95, 0.99))).toBe(true);
    expect(betterScore(score(0.8, 1, 0.99), score(0.8, 1, 0.5))).toBe(true);
    expect(betterScore(score(0.8, 1, 0.5), score(0.8, 1, 0.99))).toBe(false);
    expect(betterScore(score(0.7, 1, 0.99), score(0.8, 0.95, 0.5))).toBe(false);
    expect(betterScore(score(0.8, 0.95, 0.99), score(0.8, 1, 0.5))).toBe(false);
  });
  test("preserves v1's recall-then-threshold ordering", () => {
    expect(betterScore(score(0.8, 0.95, 0.99), score(0.8, 1, 0.5), false)).toBe(true);
    expect(betterScore(score(0.8, 1, 0.5), undefined)).toBe(true);
    expect(betterScore({ threshold: 0.5, metrics }, { threshold: 0.5, metrics })).toBe(true);
  });
});
