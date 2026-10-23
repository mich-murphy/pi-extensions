import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { RealPromptDataset, RealPromptLabel } from "../real-prompt-metrics";
import { compareRecallProfiles, tuneRecall } from "../recall-calibration";
import { parseGlossary } from "../validation";

type Row = { score: number; label: RealPromptLabel; named?: boolean; suppressed?: boolean };
function fixture(rows: readonly Row[]): RealPromptDataset {
  return {
    split: "tuning",
    concepts: [{ id: "core:refactoring", variants: ["pinned"] }],
    repeats: 1,
    gold: rows.map((row, index) => ({
      id: `scenario-${index}`,
      split: "tuning",
      labels: { "core:refactoring": { label: row.label, named: row.named ?? false } },
    })),
    observations: rows.map((row, index) => ({
      id: `scenario-${index}`,
      split: "tuning",
      repeat: 0,
      probabilities: { "core:refactoring": { pinned: row.score } },
      alreadyNamed: row.suppressed === true ? ["core:refactoring"] : [],
    })),
  };
}
function positiveRows(count = 10, score = 0.98): Row[] {
  return Array.from({ length: count }, () => ({ score, label: "positive" }));
}
function threshold(data: RealPromptDataset): number | undefined {
  return tuneRecall(data).thresholds["core:refactoring"];
}
const negative: Row = { score: 0.9, label: "negative" };

describe("recall calibration", () => {
  test("centers the winning plateau instead of selecting its highest endpoint", () => {
    const data = fixture([...positiveRows(), negative]);
    expect(threshold(data)).toBe(0.94);
    expect(tuneRecall(data).gaps).toStrictEqual([]);
  });

  test("higher grid point wins an exact midpoint tie; ambiguous hits do not move it", () => {
    const data = fixture([...positiveRows(10, 0.97), negative]);
    expect(threshold(data)).toBe(0.94);
    const ambiguous = fixture([
      ...positiveRows(10, 0.97),
      negative,
      { score: 0.96, label: "ambiguous" },
    ]);
    const result = tuneRecall(ambiguous);
    expect(result.thresholds).toStrictEqual(tuneRecall(data).thresholds);
    expect(result.metrics.overall.ambiguousHits).toBe(1);
    expect(result.metrics.overall.conservativePrecision).toBeCloseTo(10 / 11);
  });

  test("uses the .80 floor and does not search zero or 1", () => {
    expect(threshold(fixture(positiveRows(10, 0.81)))).toBe(0.81);
    expect(threshold(fixture(positiveRows(10, 1)))).toBe(0.9);
    expect(tuneRecall(fixture(positiveRows(10, 0.79))).gaps).toStrictEqual([
      "core:refactoring: scored precision below 0.9",
      "core:refactoring: recall below 0.7",
    ]);
  });

  test("ten distinct positives by default, not repeated attempts", () => {
    const data = fixture(positiveRows(3));
    expect(tuneRecall(data).gaps[0]).toContain("(3/10)");
    expect(tuneRecall(data, { minimumDistinctPositives: 3, recallFloor: 0.5 }).gaps).toStrictEqual(
      [],
    );
    const repeated = {
      ...data,
      repeats: 4,
      observations: data.observations.flatMap((row) =>
        Array.from({ length: 4 }, (_, repeat) => ({ ...row, repeat })),
      ),
    };
    expect(tuneRecall(repeated).gaps[0]).toContain("(3/10)");
  });

  test("infeasible refactoring stays enabled and blocks the whole result", () => {
    const data = fixture([...positiveRows(10, 0.85), ...Array.from({ length: 5 }, () => negative)]);
    const result = tuneRecall(data);
    expect(result.gaps).toContain("core:refactoring: scored precision below 0.9");
    expect(Object.keys(result.thresholds)).toStrictEqual(["core:refactoring"]);
    expect(result.thresholds["core:refactoring"]).toBeGreaterThanOrEqual(0.8);
    const inseparable = fixture([
      ...positiveRows(),
      ...Array.from({ length: 4 }, () => ({ ...negative, score: 0.98 })),
    ]);
    expect(tuneRecall(inseparable).gaps.length).toBeGreaterThan(0);
  });

  test("precision constrains recall and configurable recall floors remain blocking", () => {
    const data = fixture([...positiveRows(6, 0.98), ...positiveRows(4, 0.89), negative, negative]);
    const result = tuneRecall(data);
    expect(result.metrics.overall.precision).toBe(1);
    expect(result.metrics.overall.recall).toBe(0.6);
    expect(result.gaps).toContain("core:refactoring: recall below 0.7");
    expect(tuneRecall(data, { recallFloor: 0.5 }).gaps).toStrictEqual([]);
    expect(tuneRecall(data, { minimumDistinctPositives: 3, recallFloor: 0 }).gaps).toStrictEqual(
      [],
    );
    expect(tuneRecall(data, { precisionTarget: 0.8 }).metrics.overall.recall).toBe(1);
  });

  test("runtime suppression does not rewrite gold or exclude over-suppressed FNs", () => {
    const data = fixture([
      ...positiveRows(),
      { score: 0.98, label: "positive", suppressed: true },
      { score: 0.98, label: "positive", named: true },
    ]);
    const result = tuneRecall(data);
    expect(result.metrics.overall.overSuppressedFn).toBe(1);
    expect(result.metrics.overall.fn).toBe(1);
    expect(result.metrics.overall.redundantReminderFp).toBe(1);
    expect(result.metrics.perConcept["core:refactoring"]?.distinctUnnamedPositivePrompts).toBe(11);
  });

  test("mixed concepts are calibrated together without a per-record oracle", () => {
    const first = fixture([...positiveRows(), negative]);
    const data: RealPromptDataset = {
      ...first,
      concepts: [...first.concepts, { id: "second", variants: ["only"] }],
      gold: first.gold.map((row) => ({
        ...row,
        labels: { ...row.labels, second: { label: "positive", named: false } },
      })),
      observations: first.observations.map((row) => ({
        ...row,
        probabilities: { ...row.probabilities, second: { only: 0.84 } },
      })),
    };
    const result = tuneRecall(data);
    expect(result.thresholds).toStrictEqual({ "core:refactoring": 0.94, second: 0.82 });
    expect(result.gaps).toStrictEqual([]);
    expect(result.metrics.overall.tp).toBe(21);
  });

  test("rejects heldout, incomplete matrices, duplicate observations and unpinned variants", () => {
    const data = fixture(positiveRows());
    expect(() => tuneRecall({ ...data, split: "heldout" })).toThrow(/never heldout/u);
    expect(() => tuneRecall({ ...data, observations: [] })).toThrow(/Missing observations/u);
    expect(() =>
      tuneRecall({ ...data, observations: [...data.observations, ...data.observations] }),
    ).toThrow(/Duplicate/u);
    expect(() =>
      tuneRecall({
        ...data,
        concepts: [{ id: "core:refactoring", variants: ["pinned", "other"] }],
      }),
    ).toThrow(/missing or extra/u);
    const multiple = {
      ...data,
      concepts: [{ id: "core:refactoring", variants: ["pinned", "other"] }],
      observations: data.observations.map((row) => ({
        ...row,
        probabilities: { "core:refactoring": { pinned: 0.98, other: 0.98 } },
      })),
    };
    expect(() => tuneRecall(multiple)).toThrow(/one pinned/u);
    const bad = {
      ...data,
      observations: data.observations.map((row) => ({
        ...row,
        probabilities: { "core:refactoring": { pinned: Number.NaN } },
      })),
    };
    expect(() => tuneRecall(bad)).toThrow(/finite/u);
  });

  test.each([
    { minimumDistinctPositives: 0 },
    { minimumDistinctPositives: 1.5 },
    { precisionTarget: 0 },
    { precisionTarget: Number.NaN },
    { recallFloor: 1.01 },
    { recallFloor: -0.01 },
  ])("rejects invalid options %j", (options) => {
    expect(() => tuneRecall(fixture(positiveRows()), options)).toThrow(/Invalid|must be/u);
  });

  test("whole-profile comparison preserves inputs and emits no accepted-policy artifact", () => {
    const data = fixture([...positiveRows(), negative]);
    const before = JSON.stringify(data);
    const result = compareRecallProfiles(data, structuredClone(data));
    expect(result.baseline).toStrictEqual(result.candidate);
    expect(JSON.stringify(data)).toBe(before);
    expect(Object.keys(result.baseline).toSorted()).toStrictEqual([
      "gaps",
      "metrics",
      "thresholds",
    ]);
    expect(() => compareRecallProfiles(data, fixture(positiveRows(9)))).toThrow(/identical gold/u);
  });
});

function load(name: string) {
  const value: unknown = JSON.parse(
    readFileSync(new URL(`../evals/recall/${name}-core.json`, import.meta.url), "utf8"),
  );
  const result = parseGlossary(value, name, "core");
  if (!result.ok) {
    throw new Error(result.errors.join("; "));
  }
  return result.value;
}

describe("recognition candidate scope", () => {
  test("baseline preserves archived expansion bytes and candidate preserves all 51 canonical concept records", () => {
    const original = readFileSync(
      new URL("../evals/recall/source/glossary/core.json.txt", import.meta.url),
      "utf8",
    );
    expect(
      readFileSync(new URL("../evals/recall/baseline-core.json", import.meta.url), "utf8"),
    ).toBe(original);
    const baseline = load("baseline");
    const candidate = load("semantic-repair");
    expect(candidate.concepts).toHaveLength(51);
    expect(candidate.concepts).toStrictEqual(baseline.concepts);
    const changed = new Set([
      "core:refactoring",
      "core:low-coupling",
      "core:make-illegal-states-unrepresentable",
      "core:value-object",
      "core:ablation-study",
    ]);
    for (const [index, item] of candidate.recognition.entries()) {
      const prior = baseline.recognition[index];
      expect(item.questionStyle).toBe(prior?.questionStyle);
      expect(item.tip).toBe(prior?.tip);
    }
    expect(candidate.recognition.filter((item) => !changed.has(item.conceptId))).toStrictEqual(
      baseline.recognition.filter((item) => !changed.has(item.conceptId)),
    );
  });
});
