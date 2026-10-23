import { computeRealPromptMetrics } from "./real-prompt-metrics";
import type {
  RealPromptDataset,
  RealPromptMetrics,
  RealPromptSelections,
} from "./real-prompt-metrics";

const GRID = Array.from({ length: 20 }, (_, i) => (80 + i) / 100);
function need<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Missing validated matrix entry.");
  }
  return value;
}
type Counts = { tp: number[]; fp: number[] };
type Rank = readonly number[];
function add(counts: Counts, kind: number[], c: number, direction: number) {
  if (kind[c] === 1) {
    counts.tp[c] = need(counts.tp[c]) + direction;
  }
  if (kind[c] === -1) {
    counts.fp[c] = need(counts.fp[c]) + direction;
  }
}

function tie(index: number) {
  return Math.abs(need(GRID[index]) - 0.895);
}
function compare(a: Rank, b: Rank): number {
  for (let i = 0; i < a.length; i++) {
    const delta = need(a[i]) - need(b[i]);
    if (Math.abs(delta) > 1e-10) {
      return delta;
    }
  }
  return 0;
}
function selections(
  data: RealPromptDataset,
  thresholds: Record<string, number>,
): RealPromptSelections {
  return Object.fromEntries(
    data.concepts.map(({ id, variants }) => [
      id,
      {
        enabled: true,
        variant: need(variants[0]),
        threshold: need(thresholds[id]),
      },
    ]),
  );
}

function compileData(data: RealPromptDataset) {
  if (data.split !== "tuning") {
    throw new Error("Aggregate fitting forbids heldout inputs.");
  }
  const ids = data.concepts.map(({ id }) => id).toSorted((a, b) => a.localeCompare(b));
  const initial = Object.fromEntries(ids.map((id) => [id, 0.8]));
  // Validate the full raw matrix before any eligibility masking.
  const raw = computeRealPromptMetrics(data, selections(data, initial));
  if (data.concepts.some(({ variants }) => variants.length !== 1)) {
    throw new Error("Exactly one pinned variant per concept is required.");
  }
  const variants = ids.map((id) => need(need(data.concepts.find((c) => c.id === id)).variants[0]));
  const gold = new Map(data.gold.map((row) => [row.id, row]));
  const n = ids.length;
  const positiveTotals = ids.map((id) => {
    const score = need(raw.perConcept[id]);
    return score.tp + score.fn;
  });
  const totalPositive = positiveTotals.reduce((a, b) => a + b, 0);
  const requiredTp = positiveTotals.map((total) => Math.ceil(total * 0.7 - 1e-10));
  const rows = data.observations.map((row) => {
    const labels = need(gold.get(row.id)).labels;
    const eligible = ids.map((id, c) =>
      GRID.map(
        (threshold) =>
          !row.alreadyNamed.includes(id) &&
          need(need(row.probabilities[id])[need(variants[c])]) >= threshold,
      ),
    );
    return {
      // 1 = TP, -1 = FP, 0 = ambiguous. Named gold is always FP if emitted.
      kind: ids.map((id) => {
        const label = need(labels[id]);
        if (label.named || label.label === "negative") {
          return -1;
        }
        return Number(label.label === "positive");
      }),
      eligible,
      active: eligible.flatMap((flags, c) => (flags[0] === true ? [c] : [])),
      lastEligible: eligible.map((flags) => flags.lastIndexOf(true)),
    };
  });
  return { ids, variants, n, totalPositive, requiredTp, rows };
}

type Compiled = ReturnType<typeof compileData>;

function rank(counts: Counts, compiled: Compiled): Rank {
  const tp = counts.tp.reduce((a, b) => a + b, 0);
  const fp = counts.fp.reduce((a, b) => a + b, 0);
  return [
    compiled.requiredTp.reduce(
      (sum, target, c) => sum + Math.max(0, target - need(counts.tp[c])),
      0,
    ),
    Math.max(0, 0.9 * (tp + fp) - tp),
    Math.max(0, 0.85 * compiled.totalPositive - tp),
    -tp,
    fp,
  ];
}

function empty(n: number): Counts {
  return { tp: Array.from({ length: n }, () => 0), fp: Array.from({ length: n }, () => 0) };
}

function evaluate(state: number[], compiled: Compiled): Counts {
  const counts = empty(compiled.n);
  for (const row of compiled.rows) {
    let visible = 0;
    for (let c = 0; c < compiled.n && visible < 3; c++) {
      if (need(row.eligible[c])[need(state[c])] === true) {
        add(counts, row.kind, c, 1);
        visible++;
      }
    }
  }
  return counts;
}

function coordinateBase(state: number[], c: number, compiled: Compiled) {
  const base = empty(compiled.n);
  const others = compiled.rows.map((row) => {
    const visible: number[] = [];
    for (const k of row.active) {
      if (visible.length === 3) {
        break;
      }
      if (k !== c && need(row.eligible[k])[need(state[k])] === true) {
        visible.push(k);
        add(base, row.kind, k, 1);
      }
    }
    return visible;
  });
  return { base, others };
}

function coordinateRanks(
  c: number,
  compiled: Compiled,
  cache: ReturnType<typeof coordinateBase>,
): Rank[] {
  const deltas = GRID.map(() => empty(compiled.n));
  for (let r = 0; r < compiled.rows.length; r++) {
    const row = need(compiled.rows[r]);
    const visible = need(cache.others[r]);
    const last = need(row.lastEligible[c]);
    if (last >= 0 && (visible.length < 3 || c < need(visible[2]))) {
      const delta = need(deltas[last]);
      add(delta, row.kind, c, 1);
      if (visible.length === 3) {
        add(delta, row.kind, need(visible[2]), -1);
      }
    }
  }
  const counts = { tp: [...cache.base.tp], fp: [...cache.base.fp] };
  const ranks: Rank[] = [];
  for (let grid = GRID.length - 1; grid >= 0; grid--) {
    const delta = need(deltas[grid]);
    for (let k = 0; k < compiled.n; k++) {
      counts.tp[k] = need(counts.tp[k]) + need(delta.tp[k]);
      counts.fp[k] = need(counts.fp[k]) + need(delta.fp[k]);
    }
    ranks[grid] = rank(counts, compiled);
  }
  return ranks;
}

function winsCoordinateTie(grid: number, winner: number, order: number) {
  return (
    order < 0 ||
    (order === 0 &&
      (tie(grid) < tie(winner) - 1e-10 ||
        (Math.abs(tie(grid) - tie(winner)) < 1e-10 && grid < winner)))
  );
}

function coordinate(state: number[], c: number, compiled: Compiled) {
  const cache = coordinateBase(state, c, compiled);
  const ranks = coordinateRanks(c, compiled, cache);
  let winner = need(state[c]);
  let winnerRank: Rank | undefined;
  for (let grid = 0; grid < GRID.length; grid++) {
    const candidateRank = need(ranks[grid]);
    const order = winnerRank === undefined ? -1 : compare(candidateRank, winnerRank);
    if (winsCoordinateTie(grid, winner, order)) {
      winner = grid;
      winnerRank = candidateRank;
    }
  }
  return winner;
}

function sweepCoordinates(state: number[], sweep: number, compiled: Compiled) {
  let changed = false;
  let candidatesEvaluated = 0;
  for (let step = 0; step < compiled.n; step++) {
    const c = (step + sweep) % compiled.n;
    const winner = coordinate(state, c, compiled);
    candidatesEvaluated += GRID.length;
    changed ||= state[c] !== winner;
    state[c] = winner;
  }
  return { changed, candidatesEvaluated };
}

function betterStart(currentRank: Rank, bestRank: Rank, state: number[], best: number[]) {
  return (
    compare(currentRank, bestRank) < 0 ||
    (compare(currentRank, bestRank) === 0 &&
      state.reduce((sum, grid) => sum + tie(grid), 0) <
        best.reduce((sum, grid) => sum + tie(grid), 0))
  );
}

function search(compiled: Compiled) {
  let best = Array.from({ length: compiled.n }, () => 0);
  let bestRank = rank(evaluate(best, compiled), compiled);
  let candidatesEvaluated = 0;
  // Fixed seeds and bounds make both running time and output reproducible.
  for (let start = 0; start < 8; start++) {
    const state = compiled.ids.map((_, c) =>
      start < 4 ? ([0, 9, 15, 19][start] ?? 0) : (c * 13 + start * 7) % 20,
    );
    for (let sweep = 0; sweep < 12; sweep++) {
      const result = sweepCoordinates(state, sweep, compiled);
      candidatesEvaluated += result.candidatesEvaluated;
      const currentRank = rank(evaluate(state, compiled), compiled);
      if (betterStart(currentRank, bestRank, state, best)) {
        best = [...state];
        bestRank = currentRank;
      }
      if (!result.changed) {
        break;
      }
    }
  }
  return { best, candidatesEvaluated };
}

function finalMask(data: RealPromptDataset, best: number[], compiled: Compiled): RealPromptDataset {
  return {
    ...data,
    observations: data.observations.map((row, r) => {
      let visible = 0;
      return {
        ...row,
        probabilities: Object.fromEntries(
          compiled.ids.map((id, c) => {
            const eligible = need(need(compiled.rows[r]).eligible[c])[need(best[c])] === true;
            const hidden = eligible && visible++ >= 3;
            return [id, hidden ? { [need(compiled.variants[c])]: 0 } : need(row.probabilities[id])];
          }),
        ),
      };
    }),
  };
}

function gapsFor(ids: string[], metrics: RealPromptMetrics) {
  const coverageGaps = ids
    .filter((id) => need(metrics.perConcept[id]).distinctUnnamedPositivePrompts < 10)
    .map(
      (id) =>
        `${id}: insufficient distinct unnamed positives (${need(metrics.perConcept[id]).distinctUnnamedPositivePrompts}/10)`,
    );
  const gaps = [...coverageGaps];
  for (const id of ids) {
    if ((need(metrics.perConcept[id]).recall ?? 0) < 0.7) {
      gaps.push(`${id}: displayed recall below 0.7`);
    }
  }
  if ((metrics.overall.precision ?? 0) < 0.9) {
    gaps.push("aggregate displayed scored precision below 0.9");
  }
  if ((metrics.overall.recall ?? 0) < 0.85) {
    gaps.push("aggregate displayed recall below 0.85");
  }
  return { coverageGaps, gaps };
}

/**
 * Development-only bounded deterministic coordinate search, NOT a global optimizer or promoter.
 * All concepts remain enabled. The objective is displayed class TP deficit, aggregate scored
 * precision deficit, aggregate recall deficit, then maximum TP/minimum FP. Equal-score grid
 * plateaus prefer the center (.895), then the lower grid point; never automatically the highest.
 * Eligibility is precomputed; each coordinate uses cached first-three OTHER concepts per attempt.
 * No classifier, registry, IO, heldout fitting, or historical tuning behavior is involved.
 */
export function fitAggregateRecall(data: RealPromptDataset) {
  const compiled = compileData(data);
  const { best, candidatesEvaluated } = search(compiled);
  const thresholds = Object.fromEntries(
    compiled.ids.map((id, c) => [id, need(GRID[need(best[c])])]),
  );
  const selected = selections(data, thresholds);
  // Full actual widget scoring is the final authority, not the search surrogate.
  const metrics = computeRealPromptMetrics(finalMask(data, best, compiled), selected);
  const { coverageGaps, gaps } = gapsFor(compiled.ids, metrics);
  const feasible = gaps.length === 0;
  return {
    developmentOnly: true,
    promotable: false,
    exhaustive: false,
    searchMethod: "deterministic-8-start-12-sweep-coordinate-precomputed-eligibility",
    tieBreak:
      "equal objective: nearest .895 grid center, then lower; equal multistarts retain earlier unless closer to center",
    status: feasible ? "feasible-development-candidate" : "search-no-feasible-candidate",
    feasible,
    coverageGaps,
    gaps,
    thresholds,
    metrics,
    candidatesEvaluated,
    limitation:
      "Bounded heuristic; failure is not mathematical proof of infeasibility. No native phase may advance failed calibration.",
  } as const;
}
