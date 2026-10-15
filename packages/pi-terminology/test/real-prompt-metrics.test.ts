// Malformed fixtures deliberately bypass static types to exercise runtime validation.
/* oxlint-disable typescript/no-unsafe-type-assertion */
import { describe, expect, test } from "vitest";
import { computeRealPromptMetrics, tuneRealPromptThresholds } from "../real-prompt-metrics";
import type {
  RealPromptDataset,
  RealPromptLabel,
  RealPromptSelections,
} from "../real-prompt-metrics";

type Row = {
  readonly id: string;
  readonly label: RealPromptLabel;
  readonly named?: boolean;
  readonly probability?: number;
  readonly other?: number;
  readonly alreadyNamed?: boolean;
};

function dataset(rows: readonly Row[], repeats = 1): RealPromptDataset {
  return {
    split: "tuning",
    concepts: [{ id: "x", variants: ["preferred", "other"] }],
    repeats,
    gold: rows.map((row) => ({
      id: row.id,
      split: "tuning",
      labels: { x: { label: row.label, named: row.named ?? false } },
    })),
    observations: rows.flatMap((row) =>
      Array.from({ length: repeats }, (_, repeat) => ({
        id: row.id,
        split: "tuning" as const,
        repeat,
        probabilities: {
          x: { preferred: row.probability ?? 0.99, other: row.other ?? row.probability ?? 0.99 },
        },
        alreadyNamed: row.alreadyNamed === true ? ["x"] : [],
      })),
    ),
  };
}

function positives(count = 10, probability = 0.99): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index}`,
    label: "positive",
    probability,
  }));
}

const selected: RealPromptSelections = {
  x: { enabled: true, variant: "preferred", threshold: 0.9 },
};

function score(data: RealPromptDataset) {
  return computeRealPromptMetrics(data, selected);
}

function first<T>(values: readonly T[]): T {
  const [value] = values;
  if (value === undefined) {
    throw new Error("Expected a test fixture.");
  }
  return value;
}

function freeze(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    freeze(child);
  }
}

function withSecondConcept(original: RealPromptDataset): RealPromptDataset {
  return {
    ...original,
    concepts: [...original.concepts, { id: "y", variants: ["only"] }],
    gold: original.gold.map((gold) => ({
      ...gold,
      labels: { ...gold.labels, y: { label: "positive", named: false } },
    })),
    observations: original.observations.map((observation, index) => ({
      ...observation,
      probabilities: { ...observation.probabilities, y: { only: 0.95 } },
      alreadyNamed: index === 1 ? ["y"] : [],
    })),
  };
}

function asHeldout(data: RealPromptDataset): RealPromptDataset {
  return {
    ...data,
    split: "heldout",
    gold: data.gold.map((gold) => ({ ...gold, split: "heldout" })),
    observations: data.observations.map((observation) => ({ ...observation, split: "heldout" })),
  };
}

describe("real-prompt reminder scoring", () => {
  test("uses gold named for expected reminders and runtime alreadyNamed only for suppression", () => {
    const result = score(
      dataset([
        { id: "hit", label: "positive" },
        { id: "low", label: "positive", probability: 0.2 },
        { id: "over-suppressed", label: "positive", alreadyNamed: true },
        { id: "redundant", label: "positive", named: true },
        { id: "correctly-suppressed", label: "positive", named: true, alreadyNamed: true },
        { id: "negative", label: "negative" },
        { id: "negative-suppressed", label: "negative", alreadyNamed: true },
        { id: "ambiguous", label: "ambiguous" },
        { id: "ambiguous-suppressed", label: "ambiguous", alreadyNamed: true },
        { id: "named-ambiguous", label: "ambiguous", named: true },
      ]),
    );
    expect(result).toMatchObject({ prompts: 10, attempts: 10 });
    expect(result.overall).toMatchObject({
      tp: 1,
      fp: 3,
      fn: 2,
      ambiguousHits: 1,
      redundantReminderFp: 2,
      overSuppressedFn: 1,
      precision: 0.25,
      conservativePrecision: 0.2,
    });
    expect(result.overall.recall).toBeCloseTo(1 / 3);
    expect(result.perConcept.x?.distinctUnnamedPositivePrompts).toBe(3);
  });

  test("scores multiple labels independently and aggregates counts, not macro averages", () => {
    const original = dataset([
      { id: "a", label: "positive" },
      { id: "b", label: "negative" },
    ]);
    const multi = withSecondConcept(original);
    const result = computeRealPromptMetrics(multi, {
      ...selected,
      y: { enabled: true, variant: "only", threshold: 0.95 },
    });
    expect(result.perConcept.x).toMatchObject({ tp: 1, fp: 1, fn: 0 });
    expect(result.perConcept.y).toMatchObject({ tp: 1, fp: 0, fn: 1, overSuppressedFn: 1 });
    expect(result.overall).toMatchObject({ tp: 2, fp: 1, fn: 1 });
    expect(result.overall.precision).toBeCloseTo(2 / 3);
  });

  test("repeats add attempts but neither positive evidence nor Wilson sample size", () => {
    const rows: Row[] = [...positives(), { id: "false", label: "negative" }];
    const once = score(dataset(rows));
    const repeated = score(dataset(rows, 5));
    expect(repeated).toMatchObject({ prompts: 11, attempts: 55 });
    expect(repeated.overall).toMatchObject({ tp: 50, fp: 5 });
    expect(repeated.perConcept.x?.distinctUnnamedPositivePrompts).toBe(10);
    expect(repeated.perConcept.x?.distinctPromptEvidence).toStrictEqual(
      once.perConcept.x?.distinctPromptEvidence,
    );
    expect(repeated.uncertainty).toContain("not independent");
  });

  test("distinct evidence uses any-repeat hits, including an unstable false reminder", () => {
    const original = dataset(
      [
        { id: "a", label: "positive" },
        { id: "b", label: "negative" },
      ],
      2,
    );
    const result = score({
      ...original,
      observations: original.observations.map((observation) => ({
        ...observation,
        probabilities: { x: { preferred: observation.repeat, other: 0 } },
      })),
    });
    expect(result.overall).toMatchObject({ tp: 1, fp: 1, fn: 1 });
    expect(result.perConcept.x?.distinctPromptEvidence).toMatchObject({ tp: 1, fp: 1, fn: 0 });
  });

  test("empty and zero-denominator scores are null, not vacuous success", () => {
    const empty = score(dataset([]));
    expect(empty).toMatchObject({ prompts: 0, attempts: 0 });
    expect(empty.overall).toMatchObject({
      precision: null,
      conservativePrecision: null,
      recall: null,
    });
    expect(empty.perConcept.x?.distinctPromptEvidence.precisionWilson95).toBeNull();
    expect(score(dataset([{ id: "a", label: "ambiguous" }])).overall).toMatchObject({
      tp: 0,
      fp: 0,
      fn: 0,
      ambiguousHits: 1,
      precision: null,
      conservativePrecision: 0,
      recall: null,
    });
    const disabled = computeRealPromptMetrics(dataset(positives()), {
      x: { enabled: false, reason: "precision-below-target" },
    });
    expect(disabled.overall).toMatchObject({ tp: 0, fn: 10, precision: null, recall: 0 });
  });
});

describe("tuning-only variant and threshold selection", () => {
  test("enables with minimum evidence, but honestly reports wide uncertainty", () => {
    const result = tuneRealPromptThresholds(dataset(positives()));
    expect(result).toMatchObject({
      split: "tuning",
      thresholdFloor: 0.9,
      minimumDistinctPositives: 10,
      precisionTarget: 0.9,
      precisionMode: "scored",
      selections: { x: { enabled: true, variant: "preferred", threshold: 0.99 } },
    });
    expect(result.metrics.perConcept.x?.distinctPromptEvidence.precisionWilson95?.[0]).toBeLessThan(
      0.75,
    );
    expect(result.metrics.uncertainty).toContain("not a precision guarantee");
  });

  test("accepts exactly 90% empirical precision by default and rejects below it", () => {
    const rows: Row[] = [
      ...positives(18),
      { id: "n1", label: "negative" },
      { id: "n2", label: "negative" },
    ];
    const result = tuneRealPromptThresholds(dataset(rows));
    expect(result).toMatchObject({
      precisionTarget: 0.9,
      selections: { x: { enabled: true, variant: "preferred", threshold: 0.99 } },
      metrics: { overall: { tp: 18, fp: 2, precision: 0.9, recall: 1 } },
    });
    expect(
      tuneRealPromptThresholds(dataset([...rows, { id: "n3", label: "negative" }])).selections.x,
    ).toStrictEqual({ enabled: false, reason: "precision-below-target" });
  });

  test("explicit 95% reproduces historical acceptance independently of the default", () => {
    const rows: Row[] = [...positives(19), { id: "n1", label: "negative" }];
    const options = { precisionTarget: 0.95 };
    const result = tuneRealPromptThresholds(dataset(rows), options);
    expect(result).toMatchObject({
      thresholdFloor: 0.9,
      precisionTarget: 0.95,
      selections: { x: { enabled: true } },
      metrics: { overall: { precision: 0.95 } },
    });
    const below95 = dataset([...rows, { id: "n2", label: "negative" }]);
    expect(tuneRealPromptThresholds(below95).selections.x).toMatchObject({ enabled: true });
    expect(tuneRealPromptThresholds(below95, options)).toMatchObject({
      precisionTarget: 0.95,
      selections: { x: { enabled: false, reason: "precision-below-target" } },
    });
    expect(result.metrics.uncertainty).toContain("chosen empirical precision target");
  });

  test("selects independently for each concept", () => {
    const result = tuneRealPromptThresholds(withSecondConcept(dataset(positives())));
    expect(result.selections).toStrictEqual({
      x: { enabled: true, variant: "preferred", threshold: 0.99 },
      y: { enabled: true, variant: "only", threshold: 0.95 },
    });
    expect(result.metrics.perConcept.y).toMatchObject({ tp: 9, fn: 1, overSuppressedFn: 1 });
  });

  test("repeats and named positives cannot satisfy the ten distinct unnamed positives gate", () => {
    const result = tuneRealPromptThresholds(
      dataset(
        [
          ...positives(9),
          { id: "named", label: "positive", named: true, alreadyNamed: true },
          { id: "ambiguous", label: "ambiguous" },
        ],
        20,
      ),
    );
    expect(result.selections.x).toStrictEqual({
      enabled: false,
      reason: "insufficient-unnamed-positive-prompts",
    });
    expect(result.metrics.perConcept.x?.distinctUnnamedPositivePrompts).toBe(9);
    expect(
      tuneRealPromptThresholds(dataset(positives(9), 20), { precisionTarget: 0 }).selections.x,
    ).toStrictEqual({ enabled: false, reason: "insufficient-unnamed-positive-prompts" });
    expect(tuneRealPromptThresholds(dataset([])).selections.x).toMatchObject({ enabled: false });
  });

  test("requires at least one TP; runtime over-suppression cannot produce a passing selection", () => {
    const result = tuneRealPromptThresholds(
      dataset(positives().map((row) => ({ ...row, alreadyNamed: true }))),
      { precisionTarget: 0 },
    );
    expect(result.selections.x).toStrictEqual({
      enabled: false,
      reason: "no-true-positives-above-floor",
    });
    expect(result.metrics.overall).toMatchObject({ tp: 0, fn: 10 });
  });

  test("enforces the default floor inclusively and allows an explicit alternative floor", () => {
    expect(tuneRealPromptThresholds(dataset(positives(10, 0.899))).selections.x).toStrictEqual({
      enabled: false,
      reason: "no-true-positives-above-floor",
    });
    expect(tuneRealPromptThresholds(dataset(positives(10, 0.9))).selections.x).toMatchObject({
      threshold: 0.9,
    });
    expect(
      tuneRealPromptThresholds(dataset(positives(10, 0.8)), { thresholdFloor: 0.8 }).selections.x,
    ).toMatchObject({ threshold: 0.8 });
    expect(
      tuneRealPromptThresholds(dataset(positives(10, 1)), { thresholdFloor: 1 }).selections.x,
    ).toMatchObject({ threshold: 1 });
  });

  test("keeps empirical precision acceptance independent of the probability floor", () => {
    const rows: Row[] = [...positives(19, 0.9), { id: "n", label: "negative", probability: 0.9 }];
    expect(tuneRealPromptThresholds(dataset(rows), { precisionTarget: 0.95 })).toMatchObject({
      thresholdFloor: 0.9,
      precisionTarget: 0.95,
      selections: { x: { enabled: true, threshold: 0.9 } },
      metrics: { overall: { precision: 0.95 } },
    });
    const belowFloor = dataset(positives(10, 0.8));
    expect(tuneRealPromptThresholds(belowFloor, { precisionTarget: 0.8 })).toMatchObject({
      thresholdFloor: 0.9,
      precisionTarget: 0.8,
      selections: { x: { enabled: false, reason: "no-true-positives-above-floor" } },
    });
    expect(tuneRealPromptThresholds(belowFloor, { thresholdFloor: 0.8 })).toMatchObject({
      thresholdFloor: 0.8,
      precisionTarget: 0.9,
      selections: { x: { enabled: true, threshold: 0.8 } },
    });
    expect(
      tuneRealPromptThresholds(
        dataset([...positives(10, 0.8), { id: "n", label: "negative", probability: 0.8 }]),
        { thresholdFloor: 0.8, precisionTarget: 0.95 },
      ),
    ).toMatchObject({
      thresholdFloor: 0.8,
      precisionTarget: 0.95,
      selections: { x: { enabled: false, reason: "precision-below-target" } },
    });
  });

  test("defaults to ordinary precision and makes conservative promotion an explicit opt-in", () => {
    const data = dataset([
      ...positives(),
      { id: "ambiguous", label: "ambiguous" },
      { id: "ambiguous2", label: "ambiguous" },
    ]);
    const ordinary = tuneRealPromptThresholds(data);
    expect(ordinary.selections.x).toMatchObject({ enabled: true });
    expect(ordinary.metrics.overall.precision).toBe(1);
    expect(ordinary.metrics.overall.ambiguousHits).toBe(2);
    expect(ordinary.metrics.overall.conservativePrecision).toBeCloseTo(10 / 12);
    expect(
      ordinary.metrics.perConcept.x?.distinctPromptEvidence.precisionWilson95,
    ).not.toStrictEqual(
      ordinary.metrics.perConcept.x?.distinctPromptEvidence.conservativePrecisionWilson95,
    );
    expect(tuneRealPromptThresholds(data, { precisionMode: "conservative" })).toMatchObject({
      precisionMode: "conservative",
      selections: { x: { enabled: false, reason: "precision-below-target" } },
    });
  });

  test("uses the chosen precision mode for ties, not just acceptance", () => {
    const data = dataset([
      ...positives(19).map((row) => ({ ...row, other: 0.95 })),
      { id: "ambiguous", label: "ambiguous", probability: 0.99, other: 0.2 },
    ]);
    expect(tuneRealPromptThresholds(data).selections.x).toStrictEqual({
      enabled: true,
      variant: "preferred",
      threshold: 0.99,
    });
    expect(tuneRealPromptThresholds(data, { precisionMode: "scored" })).toStrictEqual(
      tuneRealPromptThresholds(data),
    );
    expect(
      tuneRealPromptThresholds(data, { precisionMode: "conservative" }).selections.x,
    ).toStrictEqual({
      enabled: true,
      variant: "other",
      threshold: 0.95,
    });
  });

  test("in conservative mode, ambiguous hits and missed named suppression block acceptance", () => {
    for (const row of [
      { id: "extra", label: "ambiguous" as const },
      { id: "extra", label: "positive" as const, named: true },
      { id: "extra", label: "negative" as const },
    ]) {
      expect(
        tuneRealPromptThresholds(dataset([...positives(), row, { ...row, id: "extra2" }]), {
          precisionMode: "conservative",
        }).selections.x,
      ).toStrictEqual({
        enabled: false,
        reason: "precision-below-target",
      });
    }
    const data = dataset([...positives(), { id: "ambiguous", label: "ambiguous" }]);
    expect(
      tuneRealPromptThresholds(data, { precisionMode: "conservative" }).selections.x,
    ).toMatchObject({ enabled: true });
    expect(
      tuneRealPromptThresholds(data, { precisionMode: "conservative", precisionTarget: 0.95 })
        .selections.x,
    ).toStrictEqual({ enabled: false, reason: "precision-below-target" });
  });

  test("maximizes recall before precision and chooses a useful non-default variant", () => {
    const rows: Row[] = [
      ...positives(10, 0.96).map((row) => ({ ...row, other: 0.99 })),
      ...positives(9, 0.96).map((row) => ({ ...row, id: `more-${row.id}`, other: 0.2 })),
      { id: "false", label: "negative", probability: 0.96, other: 0.2 },
    ];
    // Preferred: recall 1, precision .95. Other: recall 10/19, precision 1.
    expect(tuneRealPromptThresholds(dataset(rows)).selections.x).toStrictEqual({
      enabled: true,
      variant: "preferred",
      threshold: 0.96,
    });
    const betterOther: Row[] = [
      ...positives(19, 0.2).map((row) => ({ ...row, other: 0.98 })),
      { id: "false", label: "negative", probability: 0.2 },
    ];
    expect(tuneRealPromptThresholds(dataset(betterOther)).selections.x).toStrictEqual({
      enabled: true,
      variant: "other",
      threshold: 0.98,
    });
  });

  test("breaks recall ties by precision, then threshold, then declared variant preference", () => {
    const higherPrecision = dataset([
      ...positives(19).map((row) => ({ ...row, other: 0.95 })),
      { id: "n", label: "negative", probability: 0.99, other: 0.1 },
    ]);
    expect(tuneRealPromptThresholds(higherPrecision).selections.x).toStrictEqual({
      enabled: true,
      variant: "other",
      threshold: 0.95,
    });
    const higherThreshold = dataset(
      positives().map((row) => ({ ...row, probability: 0.95, other: 0.99 })),
    );
    expect(tuneRealPromptThresholds(higherThreshold).selections.x).toStrictEqual({
      enabled: true,
      variant: "other",
      threshold: 0.99,
    });
    const tied = dataset(positives());
    expect(tuneRealPromptThresholds(tied).selections.x).toMatchObject({ variant: "preferred" });
    expect(
      tuneRealPromptThresholds({
        ...tied,
        concepts: [{ id: "x", variants: ["other", "preferred"] }],
      }).selections.x,
    ).toMatchObject({ variant: "other" });
    expect(
      tuneRealPromptThresholds({ ...tied, observations: tied.observations.toReversed() }),
    ).toStrictEqual(tuneRealPromptThresholds(tied));
  });

  test("raises the threshold to remove false hits rather than disabling unnecessarily", () => {
    const result = tuneRealPromptThresholds(
      dataset([
        ...positives(10, 0.97),
        { id: "negative", label: "negative", probability: 0.96 },
        { id: "ambiguous", label: "ambiguous", probability: 0.95 },
      ]),
    );
    expect(result.selections.x).toStrictEqual({
      enabled: true,
      variant: "preferred",
      threshold: 0.97,
    });
    expect(result.metrics.overall).toMatchObject({ tp: 10, fp: 0, ambiguousHits: 0 });
  });

  test("can score heldout with frozen selections but cannot tune heldout or mixed splits", () => {
    const tuning = dataset(positives());
    const heldout = asHeldout(tuning);
    const result = tuneRealPromptThresholds(tuning);
    expect(computeRealPromptMetrics(heldout, result.selections).split).toBe("heldout");
    expect(() => tuneRealPromptThresholds(heldout)).toThrow("never heldout");
    expect(() => tuneRealPromptThresholds(heldout, { precisionTarget: 0.95 })).toThrow(
      "never heldout",
    );
    expect(() => tuneRealPromptThresholds(asHeldout(dataset([])))).toThrow("never heldout");
    expect(() => tuneRealPromptThresholds({ ...tuning, gold: heldout.gold })).toThrow("split");
    expect(() =>
      tuneRealPromptThresholds({ ...tuning, observations: heldout.observations }),
    ).toThrow("split");
    // Selecting on the tuning set does not consult the heldout probabilities.
    const badHeldout = asHeldout(dataset(positives(10, 0.1)));
    expect(computeRealPromptMetrics(badHeldout, result.selections).overall).toMatchObject({
      tp: 0,
      fn: 10,
    });
  });
});

describe("input validation", () => {
  const base = dataset([{ id: "a", label: "positive" }]);
  const gold = first(base.gold);
  const observation = first(base.observations);

  test.each([
    ["duplicate gold", { ...base, gold: [gold, gold] }, "unique"],
    ["duplicate attempt", { ...base, observations: [observation, observation] }, "Duplicate"],
    ["missing attempt", { ...base, observations: [] }, "Missing"],
    ["missing repeat", { ...base, repeats: 2 }, "Missing"],
    [
      "extra attempt",
      { ...base, observations: [observation, { ...observation, id: "extra" }] },
      "Extra",
    ],
    [
      "missing concept",
      { ...base, observations: [{ ...observation, probabilities: {} }] },
      "missing or extra",
    ],
    [
      "extra concept",
      {
        ...base,
        observations: [
          { ...observation, probabilities: { ...observation.probabilities, extra: {} } },
        ],
      },
      "missing or extra",
    ],
    [
      "missing variant",
      { ...base, observations: [{ ...observation, probabilities: { x: { preferred: 1 } } }] },
      "missing or extra",
    ],
    [
      "extra variant",
      {
        ...base,
        observations: [
          { ...observation, probabilities: { x: { preferred: 1, other: 1, extra: 1 } } },
        ],
      },
      "missing or extra",
    ],
    ["missing label", { ...base, gold: [{ ...gold, labels: {} }] }, "missing or extra"],
    [
      "extra label",
      {
        ...base,
        gold: [{ ...gold, labels: { ...gold.labels, extra: { label: "negative", named: false } } }],
      },
      "missing or extra",
    ],
    ["duplicate concept", { ...base, concepts: [...base.concepts, ...base.concepts] }, "unique"],
    [
      "duplicate variant",
      { ...base, concepts: [{ id: "x", variants: ["preferred", "preferred"] }] },
      "unique",
    ],
    ["no variants", { ...base, concepts: [{ id: "x", variants: [] }] }, "nonempty"],
    [
      "duplicate named",
      { ...base, observations: [{ ...observation, alreadyNamed: ["x", "x"] }] },
      "unique",
    ],
    [
      "unknown named",
      { ...base, observations: [{ ...observation, alreadyNamed: ["unknown"] }] },
      "unknown concept",
    ],
  ])("rejects %s", (_name, malformed, message) => {
    expect(() => score(malformed as RealPromptDataset)).toThrow(message);
  });

  test.each([-1, 0.5, 1, Number.NaN, Infinity, "0", null])(
    "rejects invalid repeat %s",
    (repeat) => {
      expect(() =>
        score({ ...base, observations: [{ ...observation, repeat }] } as RealPromptDataset),
      ).toThrow("repeat");
    },
  );

  test.each([0, -1, 1.5, Number.NaN, Infinity, "1", null])(
    "rejects invalid repeats count %s",
    (repeats) => {
      expect(() => score({ ...base, repeats } as RealPromptDataset)).toThrow("Repeats");
    },
  );

  test.each([-0.1, 1.01, Number.NaN, Infinity, -Infinity, "0.99", null, undefined])(
    "rejects invalid probability %s",
    (value) => {
      const malformed = {
        ...base,
        observations: [{ ...observation, probabilities: { x: { preferred: value, other: 0.99 } } }],
      };
      expect(() => score(malformed as RealPromptDataset)).toThrow("finite number");
    },
  );

  test.each([-0.1, 1.01, Number.NaN, Infinity, "0.9", null])(
    "rejects invalid thresholds and floors %s",
    (threshold) => {
      const malformed = { x: { enabled: true, variant: "preferred", threshold } };
      expect(() => computeRealPromptMetrics(base, malformed as RealPromptSelections)).toThrow(
        "Threshold",
      );
      expect(() =>
        tuneRealPromptThresholds(base, { thresholdFloor: threshold } as { thresholdFloor: number }),
      ).toThrow("Threshold floor");
    },
  );

  test.each([-0.1, 1.01, Number.NaN, Infinity, -Infinity, "0.9", null, true])(
    "rejects invalid precision target %s",
    (precisionTarget) => {
      expect(() =>
        tuneRealPromptThresholds(base, { precisionTarget } as { precisionTarget: number }),
      ).toThrow("Precision target must be a finite number in [0, 1]");
    },
  );

  test.each([0, 1])("accepts precision target boundary %s", (precisionTarget) => {
    expect(tuneRealPromptThresholds(dataset(positives()), { precisionTarget })).toMatchObject({
      precisionTarget,
      selections: { x: { enabled: true } },
    });
  });

  test.each([null, [], "0.9", 0.9])("rejects malformed tuning options %#", (options) => {
    expect(() =>
      tuneRealPromptThresholds(base, options as unknown as { precisionTarget: number }),
    ).toThrow("Tuning options must be an object");
  });

  test.each([
    { label: "unknown", named: false },
    { label: "positive", named: "false" },
    { label: "positive" },
    null,
  ])("rejects malformed label %#", (label) => {
    expect(() =>
      score({ ...base, gold: [{ ...gold, labels: { x: label } }] } as RealPromptDataset),
    ).toThrow(Error);
  });

  test.each([
    {},
    { ...selected, extra: selected.x },
    { x: { enabled: true, variant: "missing", threshold: 0.9 } },
    { x: { enabled: true, variant: "preferred" } },
    { x: { enabled: false, reason: "unknown" } },
    { x: { enabled: "true", variant: "preferred", threshold: 0.9 } },
    { x: { enabled: false, reason: "precision-below-target", threshold: 0.9 } },
  ])("rejects malformed selection %#", (selection) => {
    expect(() => computeRealPromptMetrics(base, selection as RealPromptSelections)).toThrow(Error);
  });

  test.each([
    null,
    { ...base, split: "test" },
    { ...base, concepts: [] },
    { ...base, concepts: [{ id: " ", variants: ["preferred"] }] },
    { ...base, concepts: [{ id: "x", variants: [""] }] },
    { ...base, gold: [{ ...gold, id: "" }] },
    { ...base, observations: [{ ...observation, id: "" }] },
    { ...base, observations: null },
    { ...base, gold: null },
    { ...base, observations: [{ ...observation, alreadyNamed: "x" }] },
  ])("rejects malformed dataset %#", (malformed) => {
    expect(() => score(malformed as RealPromptDataset)).toThrow(Error);
  });

  test.each(["unknown", null, 1])("rejects invalid precision mode %s", (precisionMode) => {
    expect(() =>
      tuneRealPromptThresholds(base, { precisionMode } as unknown as { precisionMode: "scored" }),
    ).toThrow("Precision mode");
  });

  test("validates even unused variant probabilities and rejects unknown tuner options", () => {
    expect(() =>
      score({
        ...base,
        observations: [
          { ...observation, probabilities: { x: { preferred: 1, other: Number.NaN } } },
        ],
      }),
    ).toThrow("Probability");
    expect(() =>
      tuneRealPromptThresholds(base, { split: "heldout" } as unknown as { thresholdFloor: number }),
    ).toThrow("Unknown tuning option");
  });

  test("does not mutate frozen inputs", () => {
    const original = dataset(positives(), 2);
    freeze(original);
    const before = JSON.stringify(original);
    expect(() => tuneRealPromptThresholds(original)).not.toThrow(Error);
    expect(JSON.stringify(original)).toBe(before);
  });
});
