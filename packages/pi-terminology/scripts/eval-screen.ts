import { computeMetrics, meetsUsefulnessGate } from "../eval-metrics";
import type { EvalError, EvalFixture, EvalMetrics } from "../eval-metrics";
import { selectMatches, suppressAlreadyNamed } from "../selection";
import type { SelectionState } from "../selection";
import type { Catalogue, Match } from "../types";

export type RawObservation = {
  readonly id: string;
  readonly repeat: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
};

export type Screen = {
  readonly catalogue: Catalogue;
  readonly fixtures: readonly EvalFixture[];
  readonly planned: number;
  readonly options: { readonly now: () => Date; readonly dataset?: "v2" };
};

const EMPTY_STATE: SelectionState = {
  hiddenConceptIds: new Set(),
  dismissedConceptIds: new Set(),
  cooldowns: new Map(),
};

function selectedConcepts(
  catalogue: Catalogue,
  fixture: EvalFixture,
  probabilities: Readonly<Record<string, number>>,
  threshold: number,
  now: number,
  named: ReadonlySet<string>,
): string[] {
  const candidates: Match[] = [];
  for (const recognition of catalogue.recognition) {
    const probability = probabilities[recognition.conceptId] ?? 0;
    if (probability >= threshold) {
      candidates.push({
        concept: recognition.concept,
        recognition,
        probability,
        tip: recognition.tip,
      });
    }
  }
  return selectMatches(candidates, EMPTY_STATE, now, named).map((match) => match.concept.id);
}

export function metricsAt(
  run: Screen,
  raws: readonly RawObservation[],
  errors: readonly EvalError[],
  threshold: number,
  namedById?: ReadonlyMap<string, ReadonlySet<string>>,
): EvalMetrics {
  const byId = new Map(run.fixtures.map((fixture) => [fixture.id, fixture]));
  const observations = raws.map((raw) => {
    const fixture = byId.get(raw.id);
    if (fixture === undefined) {
      throw new Error("Observation has no fixture.");
    }
    return {
      ...raw,
      selected: selectedConcepts(
        run.catalogue,
        fixture,
        raw.probabilities,
        threshold,
        run.options.now().getTime(),
        namedById?.get(fixture.id) ?? suppressAlreadyNamed(fixture.prompt, run.catalogue),
      ),
    };
  });
  return computeMetrics(run.fixtures, observations, {
    threshold,
    errors,
    expectedAttempts: run.planned,
  });
}

export function chooseThreshold(run: Screen, raws: readonly RawObservation[]) {
  const rows = [];
  const namedById = new Map(
    run.fixtures.map((fixture) => [
      fixture.id,
      suppressAlreadyNamed(fixture.prompt, run.catalogue),
    ]),
  );
  let best: { readonly threshold: number; readonly metrics: EvalMetrics } | undefined;
  for (let index = 50; index <= 99; index += 1) {
    const threshold = index / 100;
    const metrics = metricsAt(run, raws, [], threshold, namedById);
    const { precision, recall, fp, meetsPrecisionTarget } = metrics.displayed;
    const meetsTarget =
      meetsPrecisionTarget &&
      (run.options.dataset !== "v2" ||
        meetsUsefulnessGate(
          metrics,
          run.catalogue.concepts.map((concept) => concept.id),
        ));
    rows.push({ threshold, precision, recall, falsePositives: fp, meetsTarget });
    if (meetsTarget && betterScore({ threshold, metrics }, best, run.options.dataset === "v2")) {
      best = { threshold, metrics };
    }
  }
  return { rows, best };
}

export function betterScore(
  left: { readonly threshold: number; readonly metrics: EvalMetrics },
  right: { readonly threshold: number; readonly metrics: EvalMetrics } | undefined,
  comparePrecision = true,
): boolean {
  if (right === undefined) {
    return true;
  }
  const differences = [
    (left.metrics.displayed.recall ?? -1) - (right.metrics.displayed.recall ?? -1),
    comparePrecision
      ? (left.metrics.displayed.precision ?? -1) - (right.metrics.displayed.precision ?? -1)
      : 0,
    left.threshold - right.threshold,
  ];
  return (differences.find((difference) => difference !== 0) ?? 0) >= 0;
}
