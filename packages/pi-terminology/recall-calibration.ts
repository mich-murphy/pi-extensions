import { computeRealPromptMetrics } from "./real-prompt-metrics";
import type {
  RealPromptDataset,
  RealPromptMetrics,
  RealPromptSelections,
} from "./real-prompt-metrics";

export type RecallOptions = {
  readonly minimumDistinctPositives?: number;
  readonly precisionTarget?: number;
  readonly recallFloor?: number;
};
export type RecallResult = {
  readonly thresholds: Record<string, number>;
  /** Any gap blocks promotion of the entire profile; no concept is disabled. */
  readonly gaps: string[];
  readonly metrics: RealPromptMetrics;
};

type Options = Required<RecallOptions>;
type Point = { threshold: number; metrics: RealPromptMetrics };
const GRID = Array.from({ length: 20 }, (_, index) => (80 + index) / 100);

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Missing validated recall value.");
  }
  return value;
}

function optionsFor(options: RecallOptions): Options {
  const resolved = {
    minimumDistinctPositives: options.minimumDistinctPositives ?? 10,
    precisionTarget: options.precisionTarget ?? 0.9,
    recallFloor: options.recallFloor ?? 0.7,
  };
  if (
    Object.keys(options).some((key) => !Object.hasOwn(resolved, key)) ||
    !Number.isSafeInteger(resolved.minimumDistinctPositives) ||
    resolved.minimumDistinctPositives < 1
  ) {
    throw new Error("Invalid recall options or minimumDistinctPositives.");
  }
  if (
    !Number.isFinite(resolved.precisionTarget) ||
    resolved.precisionTarget <= 0 ||
    resolved.precisionTarget > 1
  ) {
    throw new Error("Precision target must be in (0, 1].");
  }
  if (
    !Number.isFinite(resolved.recallFloor) ||
    resolved.recallFloor < 0 ||
    resolved.recallFloor > 1
  ) {
    throw new Error("Recall floor must be in [0, 1].");
  }
  return resolved;
}

function selections(
  data: RealPromptDataset,
  thresholds: Record<string, number>,
): RealPromptSelections {
  return Object.fromEntries(
    data.concepts.map(({ id, variants }) => [
      id,
      { enabled: true, variant: required(variants[0]), threshold: required(thresholds[id]) },
    ]),
  );
}

function profileAt(data: RealPromptDataset, threshold: number): Point {
  const thresholds = Object.fromEntries(data.concepts.map(({ id }) => [id, threshold]));
  return { threshold, metrics: computeRealPromptMetrics(data, selections(data, thresholds)) };
}

function plateau(points: readonly Point[], id: string, target: number): Point[] {
  const eligible = points.filter(({ metrics }) => {
    const scores = required(metrics.perConcept[id]);
    return scores.tp > 0 && (scores.precision ?? 0) >= target;
  });
  // Still report an enabled, in-grid diagnostic operating point when infeasible.
  const candidates = eligible.length > 0 ? eligible : points;
  const ranked = candidates.toSorted((a, b) => {
    const left = required(a.metrics.perConcept[id]);
    const right = required(b.metrics.perConcept[id]);
    return (
      (right.recall ?? 0) - (left.recall ?? 0) || (right.precision ?? 0) - (left.precision ?? 0)
    );
  });
  const best = required(required(ranked[0]).metrics.perConcept[id]);
  return ranked.filter(({ metrics }) => {
    const score = required(metrics.perConcept[id]);
    return score.tp === best.tp && score.fp === best.fp;
  });
}

function midpoint(data: RealPromptDataset, id: string, threshold: number): number {
  const gold = new Map(data.gold.map((item) => [item.id, item]));
  const variant = required(
    required(data.concepts.find((concept) => concept.id === id)).variants[0],
  );
  let excluded = 0.8;
  let selected = 1;
  for (const observation of data.observations) {
    const label = required(required(gold.get(observation.id)).labels[id]);
    if (observation.alreadyNamed.includes(id) || (!label.named && label.label === "ambiguous")) {
      continue;
    }
    const score = required(required(observation.probabilities[id])[variant]);
    if (score < threshold) {
      excluded = Math.max(excluded, score);
    } else if (!label.named && label.label === "positive") {
      selected = Math.min(selected, score);
    }
  }
  return Math.max(0.8, (excluded + selected) / 2);
}

function marginChoice(points: readonly Point[], center: number): number {
  return required(
    points.toSorted((a, b) => {
      const distance = Math.abs(a.threshold - center) - Math.abs(b.threshold - center);
      // Decimal .01 grid arithmetic can perturb mathematically exact equal distances.
      return Math.abs(distance) < 1e-12 ? b.threshold - a.threshold : distance;
    })[0],
  ).threshold;
}

function gapsFor(metrics: RealPromptMetrics, options: Options): string[] {
  const gaps: string[] = [];
  for (const [id, score] of Object.entries(metrics.perConcept)) {
    if (score.distinctUnnamedPositivePrompts < options.minimumDistinctPositives) {
      gaps.push(
        `${id}: insufficient distinct unnamed positives (${score.distinctUnnamedPositivePrompts}/${options.minimumDistinctPositives})`,
      );
    }
    if ((score.precision ?? 0) < options.precisionTarget) {
      gaps.push(`${id}: scored precision below ${options.precisionTarget}`);
    }
    if ((score.recall ?? 0) < options.recallFloor) {
      gaps.push(`${id}: recall below ${options.recallFloor}`);
    }
  }
  return gaps;
}

/**
 * Offline, development-only operating points for one pinned question per concept.
 * Searches .80–.99 inclusive (.01 steps), including every archived expansion cutoff.
 * Ranks attempt recall then scored precision per concept, subject to target precision.
 * Ties use the midpoint between the highest excluded scored observation and lowest
 * selected unnamed positive, clipped to .80, then nearest eligible grid point (higher
 * on exact ties). Ambiguous hits do not constrain this scored-precision plateau.
 * Gold named and runtime alreadyNamed remain independent; suppression FNs count.
 * Returned thresholds are diagnostics, never an accepted policy; ALL gaps block.
 */
export function tuneRecall(data: RealPromptDataset, options: RecallOptions = {}): RecallResult {
  if (data.split !== "tuning") {
    throw new Error("Recall tuning requires tuning inputs, never heldout inputs.");
  }
  const resolved = optionsFor(options);
  // Original complete-matrix validation runs before interpreting any scores.
  const initial = profileAt(data, required(GRID[0]));
  if (data.concepts.some(({ variants }) => variants.length !== 1)) {
    throw new Error("Recall tuning requires exactly one pinned variant per concept.");
  }
  const points = [initial, ...GRID.slice(1).map((threshold) => profileAt(data, threshold))];
  const thresholds = Object.fromEntries(
    data.concepts.map(({ id }) => {
      const winners = plateau(points, id, resolved.precisionTarget);
      return [id, marginChoice(winners, midpoint(data, id, required(winners[0]).threshold))];
    }),
  );
  const metrics = computeRealPromptMetrics(data, selections(data, thresholds));
  return { thresholds, gaps: gapsFor(metrics, resolved), metrics };
}

/** Tune both preregistered profiles as whole matrices, never a per-record oracle. */
export function compareRecallProfiles(
  baseline: RealPromptDataset,
  candidate: RealPromptDataset,
  options: RecallOptions = {},
): { baseline: RecallResult; candidate: RecallResult } {
  if (JSON.stringify(baseline.gold) !== JSON.stringify(candidate.gold)) {
    throw new Error("Profile comparison requires identical gold prompts and labels.");
  }
  return { baseline: tuneRecall(baseline, options), candidate: tuneRecall(candidate, options) };
}
