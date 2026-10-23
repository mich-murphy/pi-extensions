import type { Ledger } from "../eval-budget";
/* oxlint-disable typescript/no-non-null-assertion -- Validated complete probability matrices and fixed test fixtures make mandatory indexed lookups safe. */
import { computeRealPromptMetrics } from "../real-prompt-metrics";
import type {
  RealPromptDataset,
  RealPromptObservation,
  RealPromptSelections,
} from "../real-prompt-metrics";
import { tuneRecall } from "../recall-calibration";
import { stableHash } from "../validation";
import { check } from "./recall-contract";
import type { RecallFixture } from "./recall-contract";

export type RecallObservation = {
  observation: RealPromptObservation;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
};
export function dataset(
  rows: RecallFixture[],
  observations: RecallObservation[],
  ids: string[],
  split: "tuning" | "heldout" = "tuning",
): RealPromptDataset {
  const selected = new Set(rows.map((r) => r.id));
  return {
    split,
    concepts: ids.map((id) => ({ id, variants: ["native"] })),
    repeats: 1,
    gold: rows.map((r) => ({
      id: r.id,
      split,
      labels: Object.fromEntries(
        ids.map((id) => [id, { label: r.labels[id]!, named: r.named.includes(id) }]),
      ),
    })),
    observations: observations
      .filter((r) => selected.has(r.observation.id) && r.observation.repeat === 0)
      .map((r) => ({
        ...r.observation,
        split,
        alreadyNamed: r.observation.alreadyNamed.filter((id) => ids.includes(id)),
        probabilities: Object.fromEntries(ids.map((id) => [id, r.observation.probabilities[id]!])),
      })),
  };
}
function selections(thresholds: Record<string, number>): RealPromptSelections {
  return Object.fromEntries(
    Object.entries(thresholds).map(([id, threshold]) => [
      id,
      { enabled: true, variant: "native", threshold },
    ]),
  );
}
/** Runtime candidates follow compiled recognition order (canonical localeCompare IDs), not probability rank. */
function candidateIds(row: RecallObservation, thresholds: Record<string, number>): string[] {
  return Object.entries(thresholds)
    .filter(
      ([id, threshold]) =>
        !row.observation.alreadyNamed.includes(id) &&
        (row.observation.probabilities[id]?.native ?? 0) >= threshold,
    )
    .map(([id]) => id)
    .toSorted((a, b) => a.localeCompare(b));
}
function visibleIds(row: RecallObservation, thresholds: Record<string, number>): string[] {
  return candidateIds(row, thresholds).slice(0, 3);
}
/** Derived scoring view only. Truncation is NOT named suppression; raw observations are never modified. */
function widgetView(
  observations: RecallObservation[],
  thresholds: Record<string, number>,
): RecallObservation[] {
  return observations.map((row) => {
    const hidden = new Set(candidateIds(row, thresholds).slice(3));
    return {
      ...row,
      observation: {
        ...row.observation,
        probabilities: Object.fromEntries(
          Object.entries(row.observation.probabilities).map(([id, values]) => [
            id,
            hidden.has(id) ? { ...values, native: 0 } : values,
          ]),
        ),
      },
    };
  });
}
function widgetTruncatedPositives(
  rows: RecallFixture[],
  observations: RecallObservation[],
  thresholds: Record<string, number>,
) {
  let total = 0;
  for (const row of rows) {
    const observation = observations.find(
      (o) => o.observation.id === row.id && o.observation.repeat === 0,
    );
    if (observation === undefined) {
      continue;
    }
    total += candidateIds(observation, thresholds)
      .slice(3)
      .filter((id) => row.labels[id] === "positive" && !row.named.includes(id)).length;
  }
  return total;
}
function scoreMode(
  rows: RecallFixture[],
  observations: RecallObservation[],
  thresholds: Record<string, number>,
  split: "tuning" | "heldout" = "tuning",
) {
  const ids = Object.keys(thresholds);
  const metric = (rs: RecallFixture[]) =>
    computeRealPromptMetrics(dataset(rs, observations, ids, split), selections(thresholds));
  const overall = metric(rows);
  const privateRows = rows.filter((r) => r.kind === "private");
  const syntheticRows = rows.filter((r) => r.kind === "synthetic");
  const perConcept = Object.values(overall.perConcept);
  return {
    overall,
    private: privateRows.length ? metric(privateRows) : null,
    synthetic: syntheticRows.length ? metric(syntheticRows) : null,
    macro: {
      precision: perConcept.reduce((n, c) => n + (c.precision ?? 0), 0) / ids.length,
      recall: perConcept.reduce((n, c) => n + (c.recall ?? 0), 0) / ids.length,
    },
  };
}
export function scoreRecall(
  rows: RecallFixture[],
  observations: RecallObservation[],
  thresholds: Record<string, number>,
  split: "tuning" | "heldout" = "tuning",
) {
  // Validate the complete unmasked matrix first; masking cannot conceal malformed probabilities.
  const candidateSelected = scoreMode(rows, observations, thresholds, split);
  return {
    ...scoreMode(rows, widgetView(observations, thresholds), thresholds, split),
    scoringContract:
      "Primary metrics count only the first three eligible canonical localeCompare concept IDs actually named by renderReminder. +N more is not a displayed name. Hidden candidate probabilities are zeroed only in a derived scoring view; gold opportunities and alreadyNamed remain unchanged.",
    candidateSelected,
    widgetTruncatedPositiveAssignments: widgetTruncatedPositives(rows, observations, thresholds),
  };
}
function privateUseful(
  rows: RecallFixture[],
  observations: RecallObservation[],
  thresholds: Record<string, number>,
): number {
  return rows.filter(
    (r) =>
      r.kind === "private" &&
      observations.some(
        (o) =>
          o.observation.id === r.id &&
          o.observation.repeat === 0 &&
          visibleIds(o, thresholds).some(
            (id) => r.labels[id] === "positive" && !r.named.includes(id),
          ),
      ),
  ).length;
}
export function assertDevelopment(
  metrics: ReturnType<typeof scoreRecall>,
  thresholds: Record<string, number>,
  gaps: string[],
) {
  check(
    Object.keys(thresholds).length === 51 &&
      Object.values(thresholds).every((t) => Number.isFinite(t) && t >= 0.8 && t <= 0.99) &&
      gaps.length === 0,
    "Calibration gaps or invalid thresholds.",
  );
  check(
    (metrics.overall.overall.precision ?? 0) >= 0.9 &&
      (metrics.overall.overall.recall ?? 0) >= 0.85,
    "Development precision/recall gate failed.",
  );
  check(
    Object.values(metrics.overall.perConcept).every(
      (c) =>
        c.distinctUnnamedPositivePrompts >= 10 &&
        (c.precision ?? 0) >= 0.9 &&
        (c.recall ?? 0) >= 0.7,
    ),
    "Development concept coverage/precision/recall gate failed.",
  );
}
export function acceptance(
  rows: RecallFixture[],
  observations: RecallObservation[],
  thresholds: Record<string, number>,
  old10: Record<string, number>,
) {
  const metrics = scoreRecall(rows, observations, thresholds, "heldout");
  const baseline = scoreRecall(rows, observations, old10, "heldout");
  const privatePositivePrompts = rows.filter(
    (r) =>
      r.kind === "private" &&
      Object.entries(r.labels).some(([id, label]) => label === "positive" && !r.named.includes(id)),
  ).length;
  const usefulPrivatePrompts = privateUseful(rows, observations, thresholds);
  const baselineUsefulPrivatePrompts = privateUseful(rows, observations, old10);
  const passed =
    Object.keys(thresholds).length === 51 &&
    [metrics.overall, metrics.private, metrics.synthetic].every(
      (m) => m !== null && (m.overall.precision ?? 0) >= 0.9,
    ) &&
    [metrics.overall, metrics.private].every(
      (m) => m !== null && (m.overall.recall ?? 0) >= 0.85,
    ) &&
    Object.values(metrics.synthetic!.perConcept).every(
      (c) => c.distinctUnnamedPositivePrompts >= 10 && (c.recall ?? 0) >= 0.7,
    ) &&
    privatePositivePrompts >= 20 &&
    usefulPrivatePrompts > baselineUsefulPrivatePrompts;
  return {
    passed,
    metrics,
    baseline,
    privatePositivePrompts,
    usefulPrivatePrompts,
    baselineUsefulPrivatePrompts,
    usefulPrivatePromptGain: usefulPrivatePrompts - baselineUsefulPrivatePrompts,
  };
}
/** Fixed 5-fold sorted-ID round-robin holdout within consumed pilot; no acceptance data. */
export function rankPilot(rows: RecallFixture[], observations: RecallObservation[], ids: string[]) {
  const sorted = [...rows].toSorted((a, b) => a.id.localeCompare(b.id));
  let tp = 0,
    fp = 0,
    fn = 0;
  const gaps: string[] = [];
  for (let fold = 0; fold < 5; fold++) {
    const train = sorted.filter((_, i) => i % 5 !== fold),
      test = sorted.filter((_, i) => i % 5 === fold);
    const tuned = tuneRecall(dataset(train, observations, ids), {
      minimumDistinctPositives: 1,
      precisionTarget: 0.9,
      recallFloor: 0.01,
    });
    const scores = scoreRecall(test, observations, tuned.thresholds).overall.overall;
    tp += scores.tp;
    fp += scores.fp;
    fn += scores.fn;
    // Gaps in a fold are diagnostic, not a per-concept profile-selection veto.
    gaps.push(...tuned.gaps.map((id) => `${fold}/${id}`));
  }
  const precision = tp + fp ? tp / (tp + fp) : 0,
    recall = tp + fn ? tp / (tp + fn) : 0;
  const candidate = tuneRecall(dataset(rows, observations, ids), {
    minimumDistinctPositives: 3,
    precisionTarget: 0.9,
    recallFloor: 0.01,
  });
  return {
    precision,
    recall,
    fp,
    tp,
    fn,
    gaps,
    candidateGaps: candidate.gaps,
    candidateThresholds: candidate.thresholds,
    eligible: precision >= 0.9 && candidate.gaps.length === 0,
  };
}

export function verificationReport(
  result: ReturnType<typeof acceptance>,
  observations: RecallObservation[],
  thresholds: Record<string, number>,
  ids: string[],
  ledger: Ledger,
) {
  const repeats = observations
    .filter((x) => x.observation.repeat === 1)
    .map((x) => ({
      id: x.observation.id,
      probabilities: x.observation.probabilities,
      original: observations.find(
        (y) => y.observation.id === x.observation.id && y.observation.repeat === 0,
      )?.observation.probabilities,
      latencyMs: x.latencyMs,
    }));
  const emitted = (row: RecallObservation) => visibleIds(row, thresholds);
  const repeatRows = observations.filter((x) => x.observation.repeat === 1);
  const agreements = repeatRows.filter((x) => {
    const original = observations.find(
      (y) => y.observation.id === x.observation.id && y.observation.repeat === 0,
    )!;
    return stableHash(emitted(x)) === stableHash(emitted(original));
  }).length;
  const maxProbabilityMovement = Math.max(
    ...repeatRows.map((x) => {
      const original = observations.find(
        (y) => y.observation.id === x.observation.id && y.observation.repeat === 0,
      )!;
      return Math.max(
        ...ids.map((id) =>
          Math.abs(
            x.observation.probabilities[id]!.native! -
              original.observation.probabilities[id]!.native!,
          ),
        ),
      );
    }),
  );
  const latency = observations.map((x) => x.latencyMs).toSorted((a, b) => a - b);
  return {
    ...result,
    comparator:
      "Old-ten concept subset on SELECTED-profile probabilities at archived cutoffs; not exact old recognition reproduction or causal request comparison.",
    repeats,
    repeatSummary: {
      pairs: repeatRows.length,
      visibleSetAgreements: agreements,
      visibleSetAgreement: agreements / repeatRows.length,
      maxProbabilityMovement,
    },
    attempts: ledger.attempts.length,
    failures: ledger.attempts.filter((a) => a.status !== "succeeded").length,
    latency: {
      medianMs: (latency[(latency.length - 1) >> 1]! + latency[latency.length >> 1]!) / 2,
      maxMs: latency.at(-1),
      allMs: observations.map((x) => x.latencyMs),
    },
  };
}
