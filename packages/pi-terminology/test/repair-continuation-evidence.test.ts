import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { Ledger } from "../eval-budget";
import { fitAggregateRecall } from "../recall-aggregate-calibration";
import { json } from "../scripts/recall-contract";
import type { RecallFixture } from "../scripts/recall-contract";
import { dataset } from "../scripts/recall-scoring";
import type { RecallObservation } from "../scripts/recall-scoring";
import { stableHash } from "../validation";

const base = new URL("../evals/repair/continuation/", import.meta.url);
const bytes = (name: string) => readFileSync(new URL(name, base), "utf8");
const digest = (name: string) => createHash("sha256").update(bytes(name)).digest("hex");
const load = async <T>(name: string): Promise<T> => json<T>(new URL(name, base).pathname);
const line = (text: string) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Hash-bound native evidence is checked as a full matrix below.
  JSON.parse(text) as RecallObservation;
function observationAt(rows: RecallObservation[], index: number) {
  const row = rows[index];
  if (row === undefined) {
    throw new Error("Missing native observation.");
  }
  return row;
}
const observations = (name: string) =>
  bytes(name)
    .trim()
    .split("\n")
    .map((text) => line(text));
type Binding = {
  originalSources: Record<string, string>;
  continuationSources: Record<string, string>;
  originalReceiptHash: string;
  originalObservationsHash: string;
  originalSourceManifestHash: string;
  datasetHash: string;
  continuationAuthorizationHash: string;
};
type Complete = {
  native: boolean;
  binding: Binding;
  receiptHash: string;
  sourceManifestHash: string;
  continuationObservationsHash: string;
  combinedObservationsHash: string;
  ledgerHash: string;
  orderedIdsHash: string;
};

describe("native append-only continuation evidence", () => {
  test("published bytes seal a completed continuation, never acceptance or original-phase success", async () => {
    const result = await load<{ artifacts: Record<string, string> }>("result.json");
    expect(result).toMatchObject({
      developmentOnly: true,
      measured: false,
      accepted: false,
      promotable: false,
      nativeCollectionComplete: true,
      originalPhaseRemainsInterrupted: true,
      replayAuthorized: false,
      consumedReplayExecuted: false,
      acceptanceExecuted: false,
      previewArtifactAvailable: false,
      calls: {
        before: 1428,
        originalRepair: 416,
        newSucceeded: 196,
        newFailed: 0,
        newReserved: 0,
        combinedDevelopment: 612,
        total: 1624,
      },
    });
    for (const [name, sha256] of Object.entries(result.artifacts)) {
      expect(digest(name)).toBe(sha256);
    }
    expect(existsSync(new URL("../development-completion.json.txt", base))).toBe(false);
    const historical = await load("../result.json");
    expect(historical).toMatchObject({
      status: "development-interrupted-operator-timeout",
      nativeCollectionComplete: false,
    });
  });
  test("both source generations and the new receipt are independently bound", async () => {
    const complete = await load<Complete>("combined-completion.json.txt");
    const receipt = await load<{ native: boolean; binding: Binding; beforeLedgerHash: string }>(
      "receipt.json.txt",
    );
    const old = await load<{ binding: { sources: Record<string, string> } }>(
      "../development-receipt.json.txt",
    );
    expect(complete).toMatchObject({
      native: true,
      kind: "combined-development-after-interrupted-original",
      originalInterrupted: true,
      originalCompletionExists: false,
      originalCount: 416,
      continuationCount: 196,
      count: 612,
    });
    expect(receipt.native).toBe(true);
    expect(receipt.binding).toStrictEqual(complete.binding);
    expect(receipt.beforeLedgerHash).toBe(digest("../development-ledger.json.txt"));
    expect(complete.binding.originalSources).toStrictEqual(old.binding.sources);
    expect(Object.keys(complete.binding.originalSources)).toHaveLength(26);
    expect(complete.binding.originalReceiptHash).toBe(digest("../development-receipt.json.txt"));
    expect(complete.binding.originalObservationsHash).toBe(
      digest("../development-observations.jsonl"),
    );
    expect(complete.binding.originalSourceManifestHash).toBe(digest("../source-manifest.json.txt"));
    expect(complete.binding.datasetHash).toBe(
      digest("../../recall/calibration-consensus.json.txt"),
    );
    expect(complete.binding.continuationAuthorizationHash).toBe(digest("authorization.json"));
    expect(complete.receiptHash).toBe(digest("receipt.json.txt"));
    expect(complete.sourceManifestHash).toBe(digest("source-manifest.json.txt"));
    const manifest = await load<{
      originalSources: Record<string, string>;
      sources: { path: string; archive: string; sha256: string }[];
    }>("source-manifest.json.txt");
    expect(manifest.originalSources).toStrictEqual(old.binding.sources);
    expect(manifest.sources).toHaveLength(4);
    expect(Object.keys(complete.binding.continuationSources)).toHaveLength(4);
    for (const source of manifest.sources) {
      expect(digest(source.archive)).toBe(source.sha256);
      expect(complete.binding.continuationSources[source.path]).toBe(source.sha256);
    }
  });
  test("the 196 observations are exactly the never-attempted suffix with all51 probabilities", async () => {
    const rows = await load<RecallFixture[]>("../../recall/calibration-consensus.json.txt");
    const before = observations("../development-observations.jsonl");
    const added = observations("observations.jsonl");
    const profile = await load<{ questions: Record<string, unknown> }>(
      "../compiled-profile.json.txt",
    );
    const concepts = Object.keys(profile.questions).toSorted();
    expect(concepts).toHaveLength(51);
    expect(added).toHaveLength(196);
    expect(added.map((r) => r.observation.id)).toStrictEqual(rows.slice(416).map((r) => r.id));
    const all = [...before, ...added];
    expect(all.map((r) => r.observation.id)).toStrictEqual(rows.map((r) => r.id));
    for (const row of all) {
      expect(row.observation.split).toBe("tuning");
      expect(row.observation.repeat).toBe(0);
      expect(Object.keys(row.observation.probabilities).toSorted()).toStrictEqual(concepts);
      for (const value of Object.values(row.observation.probabilities)) {
        expect(Number.isFinite(value.native)).toBe(true);
        expect(value.native).toBeGreaterThanOrEqual(0);
        expect(value.native).toBeLessThanOrEqual(1);
      }
    }
    const complete = await load<Complete>("combined-completion.json.txt");
    expect(complete.continuationObservationsHash).toBe(digest("observations.jsonl"));
    expect(complete.combinedObservationsHash).toBe(stableHash(all));
    expect(complete.orderedIdsHash).toBe(stableHash(rows.map((r) => r.id)));
  });
  test("all1428 prior ledger objects remain intact and only196 new successful reservations exist", async () => {
    const ledger = await load<Ledger>("development-ledger.json.txt");
    const old = await load<Ledger>("../development-ledger.json.txt");
    const added = observations("observations.jsonl");
    expect(ledger.attempts).toHaveLength(1624);
    expect(ledger.attempts.slice(0, 1428)).toStrictEqual(old.attempts);
    expect(ledger.otherCostNanos).toBe(old.otherCostNanos);
    const tail = ledger.attempts.slice(1428);
    expect(tail.map((a) => a.recordId)).toStrictEqual(
      added.map((r) => `repair/develop-continue/${r.observation.id}/0`),
    );
    expect(new Set(ledger.attempts.map((a) => a.recordId)).size).toBe(1624);
    for (const [index, attempt] of tail.entries()) {
      expect(attempt.status).toBe("succeeded");
      expect(attempt.reservedNanos).toBe(2_752_512);
      const observation = observationAt(added, index);
      expect(attempt.inputTokens).toBe(observation.inputTokens);
      expect(attempt.outputTokens).toBe(observation.outputTokens);
      expect(attempt.observedNanos).toBe(observation.inputTokens * 42);
    }
    expect(ledger.attempts.reduce((sum, a) => sum + a.reservedNanos, 0)).toBe(4_470_079_488);
    expect(tail.reduce((sum, a) => sum + a.reservedNanos, 0)).toBe(539_492_352);
    const complete = await load<Complete>("combined-completion.json.txt");
    expect(complete.ledgerHash).toBe(digest("development-ledger.json.txt"));
  });
  test("the full combined fit and sealed report reproduce from unchanged public development labels", async () => {
    const rows = await load<RecallFixture[]>("../../recall/calibration-consensus.json.txt");
    const all = [
      ...observations("../development-observations.jsonl"),
      ...observations("observations.jsonl"),
    ];
    const profile = await load<{ questions: Record<string, unknown> }>(
      "../compiled-profile.json.txt",
    );
    const report = await load("report.json.txt");
    const fit = fitAggregateRecall(dataset(rows, all, Object.keys(profile.questions)));
    expect(createHash("sha256").update(JSON.stringify(fit)).digest("hex")).toBe(
      "81154dd0738a4020a5a3c7db1445369821e278dfe7409c744e64798f660d2e17",
    );
    expect(report).toMatchObject(fit);
    expect(report).toMatchObject({
      native: true,
      measured: false,
      accepted: false,
      developmentOnly: true,
      promotable: false,
      replayAuthorized: false,
      acceptanceExecuted: false,
    });
    const seal = await load<{ reportHash: string; completionHash: string }>("fit-seal.json.txt");
    expect(seal.reportHash).toBe(digest("report.json.txt"));
    expect(seal.completionHash).toBe(digest("combined-completion.json.txt"));
  });
});
