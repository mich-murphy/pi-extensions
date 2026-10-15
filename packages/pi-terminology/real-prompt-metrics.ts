import { wilson } from "./eval-metrics";

export type RealPromptSplit = "tuning" | "heldout";
export type RealPromptPrecisionMode = "scored" | "conservative";
export type RealPromptTuningOptions = {
  readonly thresholdFloor?: number;
  /** Empirical acceptance target in [0, 1], independent of the probability threshold floor. */
  readonly precisionTarget?: number;
  /** Ordinary TP/(TP+FP) by default; conservative additionally penalizes ambiguous hits. */
  readonly precisionMode?: RealPromptPrecisionMode;
};
export type RealPromptLabel = "positive" | "negative" | "ambiguous";
export type RealPromptConcept = {
  readonly id: string;
  /** Earlier variants win otherwise exact ties. IDs need only be unique within a concept. */
  readonly variants: readonly string[];
};
export type RealPromptGold = {
  readonly id: string;
  readonly split: RealPromptSplit;
  /** Every concept must have an explicit label, including negatives. */
  readonly labels: Readonly<
    Record<string, { readonly label: RealPromptLabel; readonly named: boolean }>
  >;
};
export type RealPromptObservation = {
  readonly id: string;
  readonly split: RealPromptSplit;
  /** Zero-based; every prompt must have exactly the declared number of repeats. */
  readonly repeat: number;
  /** concept ID -> question variant ID -> probability */
  readonly probabilities: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Runtime suppression, deliberately independent of gold `named`. */
  readonly alreadyNamed: readonly string[];
};
export type RealPromptDataset = {
  readonly split: RealPromptSplit;
  readonly concepts: readonly RealPromptConcept[];
  readonly repeats: number;
  readonly gold: readonly RealPromptGold[];
  readonly observations: readonly RealPromptObservation[];
};
export type RealPromptDisabledReason =
  | "insufficient-unnamed-positive-prompts"
  | "no-true-positives-above-floor"
  | "precision-below-target";
export type RealPromptSelection =
  | { readonly enabled: true; readonly variant: string; readonly threshold: number }
  | { readonly enabled: false; readonly reason: RealPromptDisabledReason };
export type RealPromptSelections = Readonly<Record<string, RealPromptSelection>>;

export type RealPromptScores = {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  /** Emitted ambiguous, unnamed reminders; excluded from ordinary precision and recall. */
  readonly ambiguousHits: number;
  /** Subset of FP: a reminder emitted despite gold `named`, regardless of its label. */
  readonly redundantReminderFp: number;
  /** Subset of FN: an above-threshold unnamed positive blocked by runtime suppression. */
  readonly overSuppressedFn: number;
  readonly precision: number | null;
  /** TP / (TP + FP + ambiguousHits); tuning uses this only in conservative mode. */
  readonly conservativePrecision: number | null;
  readonly recall: number | null;
};
export type RealPromptConceptMetrics = RealPromptScores & {
  readonly distinctUnnamedPositivePrompts: number;
  /** Each prompt counts once: a reminder is emitted if ANY repeat emits it. */
  readonly distinctPromptEvidence: RealPromptScores & {
    /** Ordinary precision, using distinct prompts, NOT calls, as the sample size. */
    readonly precisionWilson95: readonly [number, number] | null;
    readonly conservativePrecisionWilson95: readonly [number, number] | null;
  };
};
export type RealPromptMetrics = {
  readonly split: RealPromptSplit;
  readonly prompts: number;
  readonly attempts: number;
  readonly overall: RealPromptScores;
  readonly perConcept: Readonly<Record<string, RealPromptConceptMetrics>>;
  readonly uncertainty: string;
};
export type RealPromptTuningResult = {
  readonly split: "tuning";
  readonly thresholdFloor: number;
  readonly precisionMode: RealPromptPrecisionMode;
  readonly minimumDistinctPositives: number;
  readonly precisionTarget: number;
  readonly selections: RealPromptSelections;
  readonly metrics: RealPromptMetrics;
};

const REAL_PROMPT_THRESHOLD_FLOOR = 0.9;
const REAL_PROMPT_MINIMUM_POSITIVES = 10;
const REAL_PROMPT_PRECISION_TARGET = 0.9;

const DISABLED_REASONS = new Set<string>([
  "insufficient-unnamed-positive-prompts",
  "no-true-positives-above-floor",
  "precision-below-target",
]);
const UNCERTAINTY =
  "Wilson intervals are descriptive per-concept, distinct-prompt intervals for any-repeat hits. " +
  "Repeats are not independent samples. Ten positive prompts and meeting the chosen empirical " +
  "precision target are minimum tuning evidence, not a precision guarantee; intervals do not account for " +
  "dependent prompts or variant/threshold selection. Confirm on untouched heldout data.";

type Pair = { readonly gold: RealPromptGold; readonly observations: RealPromptObservation[] };
type Counts = Pick<
  RealPromptScores,
  "tp" | "fp" | "fn" | "ambiguousHits" | "redundantReminderFp" | "overSuppressedFn"
>;
const ZERO: Counts = {
  tp: 0,
  fp: 0,
  fn: 0,
  ambiguousHits: 0,
  redundantReminderFp: 0,
  overSuppressedFn: 0,
};

function record(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
}

function identifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a nonempty string.`);
  }
}

function probability(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a finite number in [0, 1].`);
  }
}

function array(value: unknown, name: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array.`);
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Missing validated value.");
  }
  return value;
}

function uniqueIds(value: unknown, name: string, nonempty = false): asserts value is string[] {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) {
    throw new Error(`${name} must be ${nonempty ? "a nonempty" : "an"} array.`);
  }
  const seen = new Set<string>();
  for (const item of value) {
    identifier(item, name);
    if (seen.has(item)) {
      throw new Error(`${name} must contain unique IDs.`);
    }
    seen.add(item);
  }
}

function exactKeys(value: unknown, keys: readonly string[], name: string): void {
  record(value, name);
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${name} has missing or extra keys.`);
  }
}

function validateSplit(value: unknown, expected?: RealPromptSplit): void {
  if (
    (value !== "tuning" && value !== "heldout") ||
    (expected !== undefined && value !== expected)
  ) {
    throw new Error("Split must be tuning or heldout and match the dataset split.");
  }
}

function validateConcepts(concepts: readonly RealPromptConcept[]): string[] {
  array(concepts, "Concepts");
  if (concepts.length === 0) {
    throw new Error("Concepts must be a nonempty array.");
  }
  for (const concept of concepts) {
    record(concept, "Concept");
    identifier(concept.id, "Concept ID");
    uniqueIds(concept.variants, "Variants", true);
  }
  const ids = concepts.map((concept) => concept.id);
  uniqueIds(ids, "Concept IDs", true);
  return ids;
}

function validateGold(gold: RealPromptGold, ids: readonly string[], split: RealPromptSplit): void {
  record(gold, "Gold");
  identifier(gold.id, "Gold ID");
  validateSplit(gold.split, split);
  exactKeys(gold.labels, ids, "Gold labels");
  for (const label of Object.values(gold.labels)) {
    exactKeys(label, ["label", "named"], "Gold label");
    if (
      !["positive", "negative", "ambiguous"].includes(label.label) ||
      typeof label.named !== "boolean"
    ) {
      throw new Error("Gold label must be positive, negative or ambiguous with boolean named.");
    }
  }
}

function validateObservation(observation: RealPromptObservation, data: RealPromptDataset): void {
  record(observation, "Observation");
  identifier(observation.id, "Observation ID");
  validateSplit(observation.split, data.split);
  if (
    !Number.isSafeInteger(observation.repeat) ||
    observation.repeat < 0 ||
    observation.repeat >= data.repeats
  ) {
    throw new Error("Observation repeat must be an integer in the declared repeat range.");
  }
  const ids = data.concepts.map((concept) => concept.id);
  uniqueIds(observation.alreadyNamed, "Runtime alreadyNamed");
  if (observation.alreadyNamed.some((id) => !ids.includes(id))) {
    throw new Error("Runtime alreadyNamed contains an unknown concept.");
  }
  exactKeys(observation.probabilities, ids, "Observation probabilities");
  for (const concept of data.concepts) {
    const variants = observation.probabilities[concept.id];
    exactKeys(variants, concept.variants, "Variant probabilities");
    for (const value of Object.values(required(variants))) {
      probability(value, "Probability");
    }
  }
}

/** Complete matrices only: missing attempts/labels/variants cannot silently improve precision. */
function validateDataset(data: RealPromptDataset): Pair[] {
  record(data, "Dataset");
  validateSplit(data.split);
  const ids = validateConcepts(data.concepts);
  if (!Number.isSafeInteger(data.repeats) || data.repeats < 1) {
    throw new Error("Repeats must be a positive safe integer.");
  }
  array(data.gold, "Gold");
  array(data.observations, "Observations");
  const byId = new Map<string, Pair>();
  for (const gold of data.gold) {
    validateGold(gold, ids, data.split);
    if (byId.has(gold.id)) {
      throw new Error("Gold IDs must be unique.");
    }
    byId.set(gold.id, { gold, observations: [] });
  }
  const seen = new Set<string>();
  for (const observation of data.observations) {
    validateObservation(observation, data);
    const pair = byId.get(observation.id);
    if (pair === undefined) {
      throw new Error("Extra observation: ID matches no gold prompt.");
    }
    const key = JSON.stringify([observation.id, observation.repeat]);
    if (seen.has(key)) {
      throw new Error("Duplicate observation ID/repeat.");
    }
    seen.add(key);
    pair.observations.push(observation);
  }
  const pairs = [...byId.values()];
  if (pairs.some((pair) => pair.observations.length !== data.repeats)) {
    throw new Error("Missing observations for one or more gold prompts/repeats.");
  }
  return pairs;
}

function validateSelections(data: RealPromptDataset, selections: RealPromptSelections): void {
  exactKeys(
    selections,
    data.concepts.map((concept) => concept.id),
    "Selections",
  );
  for (const concept of data.concepts) {
    const selection: unknown = selections[concept.id];
    record(selection, "Selection");
    if (selection.enabled === true) {
      exactKeys(selection, ["enabled", "variant", "threshold"], "Enabled selection");
      identifier(selection.variant, "Selection variant");
      if (!concept.variants.includes(selection.variant)) {
        throw new Error("Selection has unknown variant.");
      }
      probability(selection.threshold, "Threshold");
    } else if (selection.enabled === false) {
      exactKeys(selection, ["enabled", "reason"], "Disabled selection");
      identifier(selection.reason, "Disabled reason");
      if (!DISABLED_REASONS.has(selection.reason)) {
        throw new Error("Unknown disabled reason.");
      }
    } else {
      throw new Error("Selection enabled must be boolean.");
    }
  }
}

function add(a: Counts, b: Counts): Counts {
  return {
    tp: a.tp + b.tp,
    fp: a.fp + b.fp,
    fn: a.fn + b.fn,
    ambiguousHits: a.ambiguousHits + b.ambiguousHits,
    redundantReminderFp: a.redundantReminderFp + b.redundantReminderFp,
    overSuppressedFn: a.overSuppressedFn + b.overSuppressedFn,
  };
}

function ratio(a: number, b: number): number | null {
  return b === 0 ? null : a / b;
}

function scores(counts: Counts): RealPromptScores {
  return {
    ...counts,
    precision: ratio(counts.tp, counts.tp + counts.fp),
    conservativePrecision: ratio(counts.tp, counts.tp + counts.fp + counts.ambiguousHits),
    recall: ratio(counts.tp, counts.tp + counts.fn),
  };
}

function count(label: RealPromptGold["labels"][string], hit: boolean, suppressed: boolean): Counts {
  const wanted = label.label === "positive" && !label.named;
  return {
    tp: Number(wanted && hit),
    fp: Number(hit && (label.named || label.label === "negative")),
    fn: Number(wanted && !hit),
    ambiguousHits: Number(hit && !label.named && label.label === "ambiguous"),
    redundantReminderFp: Number(hit && label.named),
    overSuppressedFn: Number(wanted && !hit && suppressed),
  };
}

function scoreConcept(
  pairs: readonly Pair[],
  concept: string,
  selection: RealPromptSelection,
): RealPromptConceptMetrics {
  let total = ZERO;
  let distinct = ZERO;
  let positives = 0;
  for (const pair of pairs) {
    const label = required(pair.gold.labels[concept]);
    positives += Number(label.label === "positive" && !label.named);
    let anyHit = false;
    let anySuppressed = false;
    for (const observation of pair.observations) {
      const above =
        selection.enabled &&
        required(required(observation.probabilities[concept])[selection.variant]) >=
          selection.threshold;
      const suppressed = above && observation.alreadyNamed.includes(concept);
      const hit = above && !suppressed;
      total = add(total, count(label, hit, suppressed));
      anyHit ||= hit;
      anySuppressed ||= suppressed;
    }
    distinct = add(distinct, count(label, anyHit, anySuppressed));
  }
  return {
    ...scores(total),
    distinctUnnamedPositivePrompts: positives,
    distinctPromptEvidence: {
      ...scores(distinct),
      precisionWilson95: wilson(distinct.tp, distinct.tp + distinct.fp),
      conservativePrecisionWilson95: wilson(
        distinct.tp,
        distinct.tp + distinct.fp + distinct.ambiguousHits,
      ),
    },
  };
}

function summarize(
  data: RealPromptDataset,
  pairs: readonly Pair[],
  selections: RealPromptSelections,
): RealPromptMetrics {
  const entries = data.concepts.map(
    ({ id }) => [id, scoreConcept(pairs, id, required(selections[id]))] as const,
  );
  let total = ZERO;
  for (const [, metrics] of entries) {
    total = add(total, metrics);
  }
  return {
    split: data.split,
    prompts: pairs.length,
    attempts: data.observations.length,
    overall: scores(total),
    perConcept: Object.fromEntries(entries),
    uncertainty: UNCERTAINTY,
  };
}

/** Scores reminder decisions after runtime suppression. No text, IO, or classifier calls. */
export function computeRealPromptMetrics(
  data: RealPromptDataset,
  selections: RealPromptSelections,
): RealPromptMetrics {
  const pairs = validateDataset(data);
  validateSelections(data, selections);
  return summarize(data, pairs, selections);
}

type Candidate = {
  readonly selection: Extract<RealPromptSelection, { enabled: true }>;
  readonly metrics: RealPromptConceptMetrics;
};

function tuningPrecision(metrics: RealPromptScores, mode: RealPromptPrecisionMode): number | null {
  return mode === "scored" ? metrics.precision : metrics.conservativePrecision;
}

function better(
  candidate: Candidate,
  best: Candidate | undefined,
  mode: RealPromptPrecisionMode,
): boolean {
  if (best === undefined) {
    return true;
  }
  const a = candidate.metrics;
  const b = best.metrics;
  const aPrecision = tuningPrecision(a, mode);
  const bPrecision = tuningPrecision(b, mode);
  return (
    (a.recall ?? 0) > (b.recall ?? 0) ||
    (a.recall === b.recall &&
      ((aPrecision ?? 0) > (bPrecision ?? 0) ||
        (aPrecision === bPrecision && candidate.selection.threshold > best.selection.threshold)))
  );
}

function candidateThresholds(
  pairs: readonly Pair[],
  concept: string,
  variant: string,
  floor: number,
): number[] {
  // Predictions change only at observed values; include the floor for the boundary case.
  const thresholds = new Set([floor]);
  for (const { observations } of pairs) {
    for (const observation of observations) {
      const value = required(required(observation.probabilities[concept])[variant]);
      if (value >= floor) {
        thresholds.add(value);
      }
    }
  }
  return [...thresholds].toSorted((a, b) => b - a);
}

function tuneConcept(
  pairs: readonly Pair[],
  concept: RealPromptConcept,
  floor: number,
  mode: RealPromptPrecisionMode,
  precisionTarget: number,
): RealPromptSelection {
  const positives = pairs.filter(({ gold }) => {
    const label = required(gold.labels[concept.id]);
    return label.label === "positive" && !label.named;
  }).length;
  if (positives < REAL_PROMPT_MINIMUM_POSITIVES) {
    return { enabled: false, reason: "insufficient-unnamed-positive-prompts" };
  }
  let best: Candidate | undefined;
  let anyTp = false;
  for (const variant of concept.variants) {
    for (const threshold of candidateThresholds(pairs, concept.id, variant, floor)) {
      const selection = { enabled: true, variant, threshold } as const;
      const metrics = scoreConcept(pairs, concept.id, selection);
      anyTp ||= metrics.tp > 0;
      if (metrics.tp > 0 && (tuningPrecision(metrics, mode) ?? 0) >= precisionTarget) {
        const candidate = { selection, metrics };
        if (better(candidate, best, mode)) {
          best = candidate;
        }
      }
    }
  }
  return (
    best?.selection ?? {
      enabled: false,
      reason: anyTp ? "precision-below-target" : "no-true-positives-above-floor",
    }
  );
}

/**
 * Fits on tuning data ONLY. Optimizes attempt recall, the chosen precision mode, then threshold;
 * scored precision (excluding ambiguous hits) is the default, not a conservative promotion gate.
 * Exact remaining ties prefer the earlier declared variant. Repeats affect metrics but never
 * the ten-distinct-unnamed-positive gate. The probability floor and empirical precision target
 * are independently configurable, both defaulting to 0.90; use precisionTarget: 0.95 for the
 * historical acceptance target.
 * Searches the floor and observed probability values, not a fixed .01 threshold grid.
 * Empirical acceptance is not statistical certification (see returned uncertainty note).
 */
export function tuneRealPromptThresholds(
  data: RealPromptDataset,
  options: RealPromptTuningOptions = {},
): RealPromptTuningResult {
  const pairs = validateDataset(data);
  if (data.split !== "tuning") {
    throw new Error("Threshold tuning requires tuning inputs, never heldout inputs.");
  }
  record(options, "Tuning options");
  if (
    Object.keys(options).some(
      (key) => key !== "thresholdFloor" && key !== "precisionMode" && key !== "precisionTarget",
    )
  ) {
    throw new Error("Unknown tuning option.");
  }
  if (options.thresholdFloor !== undefined) {
    probability(options.thresholdFloor, "Threshold floor");
  }
  const thresholdFloor = options.thresholdFloor ?? REAL_PROMPT_THRESHOLD_FLOOR;
  if (options.precisionTarget !== undefined) {
    probability(options.precisionTarget, "Precision target");
  }
  const precisionTarget = options.precisionTarget ?? REAL_PROMPT_PRECISION_TARGET;
  if (
    options.precisionMode !== undefined &&
    options.precisionMode !== "scored" &&
    options.precisionMode !== "conservative"
  ) {
    throw new Error("Precision mode must be scored or conservative.");
  }
  const precisionMode = options.precisionMode ?? "scored";
  const selections = Object.fromEntries(
    data.concepts.map((concept) => [
      concept.id,
      tuneConcept(pairs, concept, thresholdFloor, precisionMode, precisionTarget),
    ]),
  );
  return {
    split: "tuning",
    thresholdFloor,
    precisionMode,
    minimumDistinctPositives: REAL_PROMPT_MINIMUM_POSITIVES,
    precisionTarget,
    selections,
    metrics: summarize(data, pairs, selections),
  };
}
