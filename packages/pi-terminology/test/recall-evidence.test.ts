/* oxlint-disable typescript/no-unsafe-type-assertion -- Committed evidence schemas and bytes are verified below. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "../evals/recall");
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
async function json<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(root, name), "utf8")) as T;
}
type Counts = { tp: number; fp: number; fn: number; ambiguousHits: number };
type Row = { id: string; labels: Record<string, string>; named: string[] };
type Observation = {
  observation: {
    id: string;
    alreadyNamed: string[];
    probabilities: Record<string, { native: number }>;
  };
  profile: string;
  inputTokens: number;
  outputTokens: number;
};
type Attempt = {
  status: string;
  reservedNanos: number;
  observedNanos: number;
  inputTokens: number;
  outputTokens: number;
};
async function observations(name: string): Promise<Observation[]> {
  const text = await readFile(join(root, name), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Observation);
}
/** Independent historical first-three-name replay, not today's optimizer. */
function replay(rows: Row[], obs: Observation[], thresholds: Record<string, number>): Counts {
  const cutoffs = Object.entries(thresholds).toSorted(([a], [b]) => a.localeCompare(b));
  const ids = cutoffs.map(([id]) => id);
  const byId = new Map(obs.map((o) => [o.observation.id, o.observation]));
  const counts = { tp: 0, fp: 0, fn: 0, ambiguousHits: 0 };
  for (const row of rows) {
    const o = byId.get(row.id);
    if (o === undefined) {
      throw new Error("Missing committed development observation.");
    }
    const visible = cutoffs
      .filter(([id, threshold]) => {
        const value = o.probabilities[id];
        if (value === undefined) {
          throw new Error("Incomplete committed development probability matrix.");
        }
        return !o.alreadyNamed.includes(id) && value.native >= threshold;
      })
      .slice(0, 3)
      .map(([id]) => id);
    counts.fn += ids.filter(
      (id) => row.labels[id] === "positive" && !row.named.includes(id),
    ).length;
    for (const id of visible) {
      if (row.labels[id] === "positive" && !row.named.includes(id)) {
        counts.tp++;
        counts.fn--;
      } else if (row.labels[id] === "negative" || row.named.includes(id)) {
        counts.fp++;
      } else {
        counts.ambiguousHits++;
      }
    }
  }
  return counts;
}

describe("stopped recall-development evidence", () => {
  test("all published artifact hashes and historical source archives bind exact bytes", async () => {
    const result = await json<{ publishedArtifacts: Record<string, string> }>("result.json");
    for (const [name, expected] of Object.entries(result.publishedArtifacts)) {
      expect(hash(await readFile(join(root, name)))).toBe(expected);
    }
    const sources = await json<Record<string, { sha256: string; archive: string }>>(
      "source-manifest.json.txt",
    );
    const complete = await json<{ native: boolean; binding: { sources: Record<string, string> } }>(
      "pilot-completion.json.txt",
    );
    expect(complete.native).toBe(true);
    expect(Object.keys(sources)).toHaveLength(28);
    expect(Object.keys(sources).toSorted()).toStrictEqual(
      Object.keys(complete.binding.sources).toSorted(),
    );
    for (const [name, source] of Object.entries(sources)) {
      expect(source.sha256).toBe(complete.binding.sources[name]);
      expect(hash(await readFile(join(root, source.archive)))).toBe(source.sha256);
    }
    const offlineSources = await json<Record<string, { sha256: string; archive: string }>>(
      "offline-source-manifest.json.txt",
    );
    expect(Object.keys(offlineSources)).toHaveLength(2);
    for (const source of Object.values(offlineSources)) {
      expect(hash(await readFile(join(root, source.archive)))).toBe(source.sha256);
    }
  });

  test("1012 successful attempts preserve reservations and the exact 400-call snapshot", async () => {
    const ledger = await json<{ attempts: Attempt[] }>("development-ledger.json.txt");
    const pilot = await json<{ attempts: Attempt[] }>("pilot-ledger.json.txt");
    const complete = await json<{ ledgerHash: string }>("pilot-completion.json.txt");
    expect(ledger.attempts).toHaveLength(1012);
    expect(ledger.attempts.every((a) => a.status === "succeeded")).toBe(true);
    expect(pilot.attempts).toStrictEqual(ledger.attempts.slice(0, 400));
    expect(hash(await readFile(join(root, "pilot-ledger.json.txt")))).toBe(complete.ledgerHash);
    expect(ledger.attempts.reduce((n, a) => n + a.reservedNanos, 0)).toBe(2_785_542_144);
    expect(ledger.attempts.reduce((n, a) => n + a.observedNanos, 0)).toBe(509_237_736);
    expect(ledger.attempts.reduce((n, a) => n + a.inputTokens, 0)).toBe(12_124_708);
    expect(ledger.attempts.reduce((n, a) => n + a.outputTokens, 0)).toBe(1_116_236);
  });

  test("all 1012 public observations are development-only complete matrices", async () => {
    const pilot = await observations("pilot-observations.jsonl");
    const calibration = await observations("calibration-observations.jsonl");
    expect(pilot.filter((o) => o.profile === "baseline")).toHaveLength(200);
    expect(pilot.filter((o) => o.profile === "semanticRepair")).toHaveLength(200);
    expect(calibration).toHaveLength(612);
    for (const row of [...pilot, ...calibration]) {
      expect(Object.keys(row.observation.probabilities)).toHaveLength(51);
      expect(row.inputTokens).toBeGreaterThan(0);
      expect(row.outputTokens).toBeGreaterThan(0);
    }
  });

  test("independent widget replay reproduces calibration and all offline candidates", async () => {
    const rows = await json<Row[]>("calibration-consensus.json.txt");
    const obs = await observations("calibration-observations.jsonl");
    const report = await json<{ thresholds: Record<string, number>; gaps: string[] }>(
      "calibration-report.json.txt",
    );
    expect(replay(rows, obs, report.thresholds)).toStrictEqual({
      tp: 524,
      fp: 7,
      fn: 73,
      ambiguousHits: 19,
    });
    expect(report.gaps).toStrictEqual([
      "core:low-coupling: recall below 0.7",
      "core:refactoring: recall below 0.7",
      "core:separation-of-concerns: recall below 0.7",
    ]);
    const offline = await json<{
      promotable: boolean;
      exhaustiveGlobalSearch: boolean;
      results: Record<string, Counts & { thresholds: Record<string, number> }>;
    }>("offline-visible-search.json.txt");
    expect(offline.promotable).toBe(false);
    expect(offline.exhaustiveGlobalSearch).toBe(false);
    for (const candidate of Object.values(offline.results)) {
      expect(replay(rows, obs, candidate.thresholds)).toStrictEqual({
        tp: candidate.tp,
        fp: candidate.fp,
        fn: candidate.fn,
        ambiguousHits: candidate.ambiguousHits,
      });
    }
    const corrected = await json<{
      thresholds: Record<string, number>;
      metrics: { overall: Counts };
      status: string;
      promotable: boolean;
    }>("aggregate-objective-diagnostic.json.txt");
    expect(corrected.status).toBe("search-no-feasible-candidate");
    expect(corrected.promotable).toBe(false);
    expect(replay(rows, obs, corrected.thresholds)).toStrictEqual({
      tp: corrected.metrics.overall.tp,
      fp: corrected.metrics.overall.fp,
      fn: corrected.metrics.overall.fn,
      ambiguousHits: corrected.metrics.overall.ambiguousHits,
    });
  });

  test("the stopped run makes no acceptance, private-performance or promotion claim", async () => {
    const result = await json<{
      status: string;
      promoted: boolean;
      runtimeMeasured: boolean;
      activationChanged: boolean;
      nativeCollection: Record<string, unknown>;
    }>("result.json");
    expect(result).toMatchObject({
      status: "development-blocked",
      promoted: false,
      runtimeMeasured: false,
      activationChanged: false,
      nativeCollection: {
        attempts: 1012,
        acceptance: 0,
        retries: 0,
        calibrationCompletionSealIssued: false,
        freezeReceiptIssued: false,
        verificationReceiptIssued: false,
      },
    });
  });
});
