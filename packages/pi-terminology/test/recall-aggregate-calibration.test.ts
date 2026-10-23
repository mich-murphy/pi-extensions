import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import { computeRealPromptMetrics } from "../real-prompt-metrics";
import type { RealPromptDataset, RealPromptLabel } from "../real-prompt-metrics";
import { fitAggregateRecall } from "../recall-aggregate-calibration";

const archivedSource = readFileSync(
  new URL("../evals/repair/source/recall-aggregate-calibration.ts.txt", import.meta.url),
  "utf8",
);
const archivedFit: unknown = runInNewContext(
  `${stripTypeScriptTypes(
    archivedSource
      .replaceAll(/^import[\s\S]*?from "\.\/real-prompt-metrics";\n/gmu, "")
      .replace("export function fitAggregateRecall", "function fitAggregateRecall"),
  )}\nfitAggregateRecall;`,
  { computeRealPromptMetrics },
);
function reference(data: RealPromptDataset): unknown {
  if (typeof archivedFit !== "function") {
    throw new TypeError("Missing archived reference fitter.");
  }
  return Reflect.apply(archivedFit, undefined, [data]);
}

type Row = { labels: RealPromptLabel[]; scores: number[]; named?: string[]; suppressed?: string[] };
function fixture(ids: string[], rows: Row[], repeats = 1): RealPromptDataset {
  return {
    split: "tuning",
    repeats,
    concepts: ids.map((id) => ({ id, variants: ["native"] })),
    gold: rows.map((row, r) => ({
      id: String(r),
      split: "tuning",
      labels: Object.fromEntries(
        ids.map((id, c) => [
          id,
          { label: row.labels[c] ?? "negative", named: row.named?.includes(id) ?? false },
        ]),
      ),
    })),
    observations: rows.flatMap((row, r) =>
      Array.from({ length: repeats }, (_, repeat) => ({
        id: String(r),
        split: "tuning" as const,
        repeat,
        alreadyNamed: row.suppressed ?? [],
        probabilities: Object.fromEntries(ids.map((id, c) => [id, { native: row.scores[c] ?? 0 }])),
      })),
    ),
  };
}
const copies = (n: number, row: Row) => Array.from({ length: n }, () => row);

function largeMatrix() {
  const ids = Array.from({ length: 51 }, (_, i) => `class-${String(i).padStart(2, "0")}`);
  const rows = Array.from({ length: 612 }, (_row, r) => ({
    labels: ids.map((_, c): RealPromptLabel => (c === r % 51 ? "positive" : "negative")),
    scores: ids.map((_, c) =>
      c === r % 51 ? 0.8 + (r % 20) / 100 : ((r * 17 + c * 13) % 101) / 100,
    ),
  }));
  return { ids, rows };
}
function inRange(threshold: number) {
  return threshold >= 0.8 && threshold <= 0.99;
}

function boundaryMatrix(seed: number) {
  const ids = ["f", "d", "b", "a", "e", "c"];
  const labels: RealPromptLabel[] = ["positive", "positive", "ambiguous", "negative", "negative"];
  const scores = [
    0,
    1,
    ...Array.from({ length: 20 }, (_, grid) => (80 + grid) / 100).flatMap((threshold) => [
      threshold - Number.EPSILON,
      threshold,
      threshold + Number.EPSILON,
    ]),
  ];
  const rows = Array.from({ length: 42 }, (_row, r): Row => ({
    labels: ids.map((_, c) => labels[(r * 7 + c * 11 + seed) % labels.length] ?? "negative"),
    scores: ids.map((_, c) => scores[(r * 3 + c * 5 + seed) % scores.length] ?? 0),
    named: ids.filter((_, c) => (r + c + seed) % 9 === 0),
    suppressed: ids.filter((_, c) => (r * 3 + c + seed) % 11 === 0),
  }));
  return fixture(ids, rows, (seed % 2) + 1);
}

describe("development-only aggregate displayed calibration", () => {
  test.each([0, 1, 2, 3])(
    "matches the frozen straight-search reference across cap, label and grid boundaries (seed %i)",
    (seed) => {
      expect(createHash("sha256").update(archivedSource).digest("hex")).toBe(
        "fcb229525aefbc1ee1e20ccf1793c50ef1155d1cd981a26e33be7554211edf81",
      );
      const data = boundaryMatrix(seed);
      const before = JSON.stringify(data);
      expect(JSON.stringify(fitAggregateRecall(data))).toBe(JSON.stringify(reference(data)));
      expect(JSON.stringify(data)).toBe(before);
    },
  );

  test("matches the reference on empty classes, score plateaus and displacement by ambiguous hits", () => {
    const ids = ["z", "e", "d", "c", "b", "a"];
    const rows: Row[] = [
      { labels: [], scores: [] },
      { labels: ["positive", "positive"], scores: [0.89, 0.9] },
      { labels: ["positive", "positive", "positive"], scores: [0.8, 0.8, 0.8] },
      {
        labels: ["positive", "positive", "positive", "ambiguous", "ambiguous", "ambiguous"],
        scores: [1, 1, 1, 1, 1, 1],
      },
      { labels: ["positive"], scores: [0.99, 0.99, 0.99, 0.99], named: ["c"] },
      { labels: ["positive"], scores: [0.99, 0.99, 0.99, 0.99], suppressed: ["c"] },
    ];
    for (const data of [
      fixture(ids, rows),
      fixture(["empty"], copies(2, { labels: [], scores: [] })),
    ]) {
      expect(JSON.stringify(fitAggregateRecall(data))).toBe(JSON.stringify(reference(data)));
    }
  });

  test("allows class precision below .9 when aggregate precision and every recall floor pass", () => {
    const data = fixture(
      ["a", "b"],
      [
        ...copies(10, { labels: ["positive", "negative"], scores: [1, 0] }),
        ...copies(40, { labels: ["negative", "positive"], scores: [0, 1] }),
        ...copies(2, { labels: ["negative", "negative"], scores: [1, 0] }),
      ],
    );
    const before = JSON.stringify(data);
    const result = fitAggregateRecall(data);
    expect(result.feasible).toBe(true);
    expect(result.metrics.overall).toMatchObject({
      tp: 50,
      fp: 2,
      fn: 0,
      precision: 50 / 52,
      recall: 1,
    });
    expect(result.metrics.perConcept.a?.precision).toBe(10 / 12);
    expect(result.metrics.perConcept.a?.recall).toBe(1);
    expect(result.gaps).toStrictEqual([]);
    expect(result).toMatchObject({ developmentOnly: true, promotable: false, exhaustive: false });
    expect(JSON.stringify(data)).toBe(before);
    expect(fitAggregateRecall(data)).toStrictEqual(result);
    expect(Object.values(result.thresholds)).toStrictEqual([0.89, 0.89]);
  });

  test("caps at three canonical localeCompare IDs, not score or input order, leaving hidden TP as FN", () => {
    const ids = ["d", "c", "b", "a"];
    const result = fitAggregateRecall(
      fixture(
        ids,
        copies(10, {
          labels: ["positive", "positive", "positive", "positive"],
          scores: [1, 1, 1, 1],
        }),
      ),
    );
    expect(result.metrics.overall).toMatchObject({ tp: 30, fp: 0, fn: 10 });
    expect(result.metrics.perConcept.d).toMatchObject({
      tp: 0,
      fn: 10,
      recall: 0,
      overSuppressedFn: 0,
    });
    expect(result.feasible).toBe(false);
    expect(result.status).toBe("search-no-feasible-candidate");
    expect(Object.keys(result.thresholds)).toStrictEqual(["a", "b", "c", "d"]);
  });

  test("separates exact runtime suppression from named gold and reports ambiguous conservative precision", () => {
    const result = fitAggregateRecall(
      fixture(
        ["a", "aa"],
        [
          ...copies(10, { labels: ["positive", "positive"], scores: [1, 1] }),
          { labels: ["positive", "positive"], scores: [1, 1], named: ["a"], suppressed: ["aa"] },
          { labels: ["ambiguous", "negative"], scores: [1, 0] },
        ],
      ),
    );
    expect(result.metrics.overall).toMatchObject({
      tp: 20,
      fp: 1,
      fn: 1,
      ambiguousHits: 1,
      redundantReminderFp: 1,
      overSuppressedFn: 1,
      precision: 20 / 21,
      conservativePrecision: 20 / 22,
    });
    expect(result.feasible).toBe(true);
  });

  test("does not ignore a failing class even when aggregate P/R pass", () => {
    const result = fitAggregateRecall(
      fixture(
        ["large", "refactoring"],
        [
          ...copies(100, { labels: ["positive", "negative"], scores: [1, 0] }),
          ...copies(10, { labels: ["negative", "positive"], scores: [0, 0.79] }),
        ],
      ),
    );
    expect(result.metrics.overall.precision).toBe(1);
    expect(result.metrics.overall.recall).toBeGreaterThan(0.85);
    expect(result.gaps).toContain("refactoring: displayed recall below 0.7");
    expect(result.feasible).toBe(false);
    expect(result.thresholds.refactoring).toBeDefined();
  });

  test("requires ten DISTINCT unnamed positives, not repeats or named gold", () => {
    const result = fitAggregateRecall(
      fixture(
        ["a"],
        [
          ...copies(9, { labels: ["positive"], scores: [1] }),
          { labels: ["positive"], scores: [0], named: ["a"] },
        ],
        2,
      ),
    );
    expect(result.metrics.overall.tp).toBe(18);
    expect(result.coverageGaps).toStrictEqual([
      "a: insufficient distinct unnamed positives (9/10)",
    ]);
    expect(result.feasible).toBe(false);
    expect(result.thresholds.a).toBeDefined();
  });

  test("rejects heldout, missing attempts, incomplete matrices, unknown keys, and multiple variants", () => {
    const data = fixture(["a"], copies(10, { labels: ["positive"], scores: [1] }));
    expect(() => fitAggregateRecall({ ...data, split: "heldout" })).toThrow(/heldout/u);
    expect(() => fitAggregateRecall({ ...data, observations: data.observations.slice(1) })).toThrow(
      /Missing observations/u,
    );
    expect(() =>
      fitAggregateRecall({
        ...data,
        observations: data.observations.map((row) => ({ ...row, probabilities: {} })),
      }),
    ).toThrow(/missing or extra/u);
    expect(() =>
      fitAggregateRecall({
        ...data,
        observations: data.observations.map((row) => ({
          ...row,
          probabilities: { ...row.probabilities, unknown: { native: 1 } },
        })),
      }),
    ).toThrow(/missing or extra/u);
    expect(() =>
      fitAggregateRecall({
        ...data,
        concepts: [{ id: "a", variants: ["native", "other"] }],
        observations: data.observations.map((row) => ({
          ...row,
          probabilities: { a: { native: 1, other: 1 } },
        })),
      }),
    ).toThrow(/one pinned variant/u);
  });

  test("searches within .80–.99 and trades false positives for recall using the actual cap", () => {
    const result = fitAggregateRecall(
      fixture(
        ["a"],
        [
          ...copies(10, { labels: ["positive"], scores: [0.99] }),
          ...copies(10, { labels: ["negative"], scores: [0.98] }),
        ],
      ),
    );
    expect(result.thresholds.a).toBe(0.99);
    expect(result.feasible).toBe(true);
    const floor = fitAggregateRecall(
      fixture(["a"], copies(10, { labels: ["positive"], scores: [0.8] })),
    );
    expect(floor.thresholds.a).toBe(0.8);
    expect(floor.feasible).toBe(true);
  });

  test("precomputes eligibility for a 612-row 51-class matrix in under 30 seconds", () => {
    const { ids, rows } = largeMatrix();
    const start = performance.now();
    const result = fitAggregateRecall(fixture(ids, rows));
    expect(performance.now() - start).toBeLessThan(30_000);
    expect(Object.keys(result.metrics.perConcept)).toHaveLength(51);
    expect(Object.values(result.thresholds).every((threshold) => inRange(threshold))).toBe(true);
  }, 30_000);
});
