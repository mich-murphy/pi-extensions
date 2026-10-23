export type EvalFixture = {
  readonly id: string;
  readonly prompt: string;
  readonly applicable: readonly string[];
  readonly displayed: readonly string[];
};

export type EvalObservation = {
  readonly id: string;
  readonly repeat: number;
  readonly probabilities: Readonly<Record<string, number>>;
  /** Concepts the shared runtime selector chose from the probabilities. */
  readonly selected: readonly string[];
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
};

export type EvalError = {
  readonly id: string;
  readonly repeat: number;
  readonly message: string;
};

export type Counts = { readonly tp: number; readonly fp: number; readonly fn: number };
export type Scores = Counts & {
  readonly precision: number | null;
  readonly recall: number | null;
};

export type LatencySummary = {
  readonly count: number;
  readonly meanMs: number | null;
  readonly p50Ms: number | null;
  readonly maxMs: number | null;
};

export type EvalMetrics = {
  /** Selected terms are scored as the group screen; no hidden-overflow split is applied. */
  readonly scope: "selected-terms";
  readonly prompts: number;
  readonly attempts: number;
  readonly errors: number;
  readonly missingAttempts: number;
  readonly displayed: Scores & {
    readonly precisionWilson95: readonly [number, number] | null;
    readonly meetsPrecisionTarget: boolean;
  };
  readonly nonemptyPromptCoverage: number | null;
  readonly abstentionRate: number | null;
  readonly anyFalseGroupRate: number | null;
  readonly perConcept: Readonly<Record<string, Scores>>;
  readonly applicability: Scores & { readonly threshold: number };
  readonly flips: { readonly repeatedPrompts: number; readonly unstablePrompts: number };
  readonly latency: LatencySummary;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
};

export type MetricsOptions = {
  readonly threshold: number;
  readonly errors?: readonly EvalError[];
  /** Attempts the run planned, so a short run cannot pass. Defaults to what was observed. */
  readonly expectedAttempts?: number;
  readonly precisionTarget?: number;
};

export const PRECISION_TARGET = 0.95;

/** Round two requires useful recall for every declared concept, never a vacuous subset. */
export function meetsUsefulnessGate(metrics: EvalMetrics, conceptIds: readonly string[]): boolean {
  return (
    metrics.errors === 0 &&
    metrics.missingAttempts === 0 &&
    metrics.displayed.meetsPrecisionTarget &&
    conceptIds.length === 6 &&
    new Set(conceptIds).size === 6 &&
    conceptIds.every((id) => {
      const score = metrics.perConcept[id];
      return score !== undefined && score.tp + score.fn > 0 && (score.recall ?? 0) >= 0.5;
    })
  );
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Wilson score interval, reported for context only; acceptance uses the point estimate. */
export function wilson(successes: number, total: number, z = 1.96): [number, number] | null {
  if (total === 0) {
    return null;
  }
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denominator;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

export function scoreSets(predicted: ReadonlySet<string>, expected: ReadonlySet<string>): Counts {
  let tp = 0;
  for (const item of predicted) {
    tp += expected.has(item) ? 1 : 0;
  }
  return { tp, fp: predicted.size - tp, fn: expected.size - tp };
}

function addCounts(a: Counts, b: Counts): Counts {
  return { tp: a.tp + b.tp, fp: a.fp + b.fp, fn: a.fn + b.fn };
}

function toScores(counts: Counts): Scores {
  return {
    ...counts,
    precision: ratio(counts.tp, counts.tp + counts.fp),
    recall: ratio(counts.tp, counts.tp + counts.fn),
  };
}

const ZERO: Counts = { tp: 0, fp: 0, fn: 0 };

type Pair = { readonly fixture: EvalFixture; readonly observation: EvalObservation };

function pairObservations(
  fixtures: readonly EvalFixture[],
  observations: readonly EvalObservation[],
): Pair[] {
  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  if (byId.size !== fixtures.length) {
    throw new Error("Fixture ids must be unique.");
  }
  const seen = new Set<string>();
  return observations.map((observation) => {
    const fixture = byId.get(observation.id);
    const key = `${observation.id}#${String(observation.repeat)}`;
    if (fixture === undefined) {
      throw new Error(`Observation ${observation.id} matches no fixture.`);
    }
    if (seen.has(key)) {
      throw new Error(`Duplicate observation ${key}.`);
    }
    seen.add(key);
    return { fixture, observation };
  });
}

function perConceptScores(pairs: readonly Pair[]): Record<string, Scores> {
  const totals = new Map<string, Counts>();
  for (const { fixture, observation } of pairs) {
    const selected = new Set(observation.selected);
    const displayed = new Set(fixture.displayed);
    for (const concept of new Set([...selected, ...displayed])) {
      const one = scoreSets(
        new Set(selected.has(concept) ? [concept] : []),
        new Set(displayed.has(concept) ? [concept] : []),
      );
      totals.set(concept, addCounts(totals.get(concept) ?? ZERO, one));
    }
  }
  const entries = [...totals].toSorted(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries.map(([concept, counts]) => [concept, toScores(counts)]));
}

function sumCounts(
  pairs: readonly Pair[],
  predict: (pair: Pair) => Set<string>,
  expect: (f: EvalFixture) => readonly string[],
): Counts {
  let total = ZERO;
  for (const pair of pairs) {
    total = addCounts(total, scoreSets(predict(pair), new Set(expect(pair.fixture))));
  }
  return total;
}

function aboveThreshold(observation: EvalObservation, threshold: number): Set<string> {
  return new Set(
    Object.entries(observation.probabilities)
      .filter(([, probability]) => probability >= threshold)
      .map(([concept]) => concept),
  );
}

function flipCounts(pairs: readonly Pair[]): EvalMetrics["flips"] {
  const byPrompt = new Map<string, Set<string>[]>();
  for (const { observation } of pairs) {
    const sets = byPrompt.get(observation.id) ?? [];
    sets.push(new Set(observation.selected));
    byPrompt.set(observation.id, sets);
  }
  let repeatedPrompts = 0;
  let unstablePrompts = 0;
  for (const sets of byPrompt.values()) {
    const keys = new Set(sets.map((set) => [...set].toSorted().join("\u0000")));
    repeatedPrompts += sets.length > 1 ? 1 : 0;
    unstablePrompts += keys.size > 1 ? 1 : 0;
  }
  return { repeatedPrompts, unstablePrompts };
}

export function summarizeLatency(values: readonly number[]): LatencySummary {
  if (values.length === 0) {
    return { count: 0, meanMs: null, p50Ms: null, maxMs: null };
  }
  const sorted = values.toSorted((a, b) => a - b);
  const rank = Math.ceil(sorted.length / 2) - 1;
  return {
    count: sorted.length,
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50Ms: sorted[rank] ?? null,
    maxMs: sorted.at(-1) ?? null,
  };
}

function coverage(pairs: readonly Pair[]) {
  const wanted = pairs.filter(({ fixture }) => fixture.displayed.length > 0);
  const covered = wanted.filter(({ observation }) => observation.selected.length > 0);
  const abstained = pairs.filter(({ observation }) => observation.selected.length === 0);
  const falseGroups = pairs.filter(({ fixture, observation }) =>
    observation.selected.some((concept) => !fixture.displayed.includes(concept)),
  );
  return {
    nonemptyPromptCoverage: ratio(covered.length, wanted.length),
    abstentionRate: ratio(abstained.length, pairs.length),
    anyFalseGroupRate: ratio(falseGroups.length, pairs.length),
  };
}

function sumField(pairs: readonly Pair[], field: "inputTokens" | "outputTokens"): number {
  return pairs.reduce((sum, { observation }) => sum + observation[field], 0);
}

/**
 * Scores observed attempts against the fixtures. Repeats add attempts, never prompts. Errors are
 * counted apart and any error or missing attempt fails the precision target.
 */
export function computeMetrics(
  fixtures: readonly EvalFixture[],
  observations: readonly EvalObservation[],
  options: MetricsOptions,
): EvalMetrics {
  const pairs = pairObservations(fixtures, observations);
  const errors = options.errors?.length ?? 0;
  const missingAttempts = Math.max(
    0,
    (options.expectedAttempts ?? pairs.length) - pairs.length - errors,
  );
  const displayedCounts = sumCounts(
    pairs,
    ({ observation }) => new Set(observation.selected),
    (fixture) => fixture.displayed,
  );
  const displayed = toScores(displayedCounts);
  const clean = errors === 0 && missingAttempts === 0;
  return {
    scope: "selected-terms",
    prompts: new Set(pairs.map(({ observation }) => observation.id)).size,
    attempts: pairs.length,
    errors,
    missingAttempts,
    displayed: {
      ...displayed,
      precisionWilson95: wilson(displayedCounts.tp, displayedCounts.tp + displayedCounts.fp),
      meetsPrecisionTarget:
        clean &&
        displayed.precision !== null &&
        displayed.precision >= (options.precisionTarget ?? PRECISION_TARGET),
    },
    ...coverage(pairs),
    perConcept: perConceptScores(pairs),
    applicability: {
      threshold: options.threshold,
      ...toScores(
        sumCounts(
          pairs,
          ({ observation }) => aboveThreshold(observation, options.threshold),
          (fixture) => fixture.applicable,
        ),
      ),
    },
    flips: flipCounts(pairs),
    latency: summarizeLatency(pairs.map(({ observation }) => observation.latencyMs)),
    usage: {
      inputTokens: sumField(pairs, "inputTokens"),
      outputTokens: sumField(pairs, "outputTokens"),
    },
  };
}
