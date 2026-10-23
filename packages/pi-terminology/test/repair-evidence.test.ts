import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assert, describe, expect, test } from "vitest";
import type { Ledger } from "../eval-budget";
import { json } from "../scripts/recall-contract";

type Result = {
  status: string;
  calls: Record<string, number>;
  budget: Record<string, number | boolean>;
  artifacts: Record<string, string>;
  sourceManifestSha256: string;
};
const base = new URL("../evals/repair/", import.meta.url);
const bytes = (name: string) => readFileSync(new URL(name, base));
const digest = (name: string) => createHash("sha256").update(bytes(name)).digest("hex");
const path = (name: string) => fileURLToPath(new URL(name, base));
const result = await json<Result>(path("result.json"));
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  assert(isRecord(value));
  return value;
}
function numeric(value: unknown): number {
  assert(typeof value === "number");
  return value;
}
function text(value: unknown): string {
  assert(typeof value === "string");
  return value;
}
const observations = bytes("development-observations.jsonl")
  .toString()
  .trim()
  .split("\n")
  .map((line) => record(record(JSON.parse(line)).observation));

describe("interrupted repair evidence is not a completed experiment", () => {
  test("records the operator interruption without a fitted or promotable candidate", () => {
    expect(result).toMatchObject({
      status: "development-interrupted-operator-timeout",
      measured: false,
      accepted: false,
      promotable: false,
      nativeCollectionComplete: false,
      developmentFit: "not-run-incomplete-matrix",
      previewArtifactAvailable: false,
      acceptanceExecuted: false,
      continuation: { authorized: false, requiresExplicitUserApproval: true },
      termination: { receiptPreserved: true, retryOrResumePerformed: false },
    });
    expect(result.calls).toMatchObject({
      original: 1012,
      plannedDevelopment: 612,
      repairSucceeded: 416,
      repairFailed: 0,
      repairReservedUnsettled: 0,
      unattemptedDevelopment: 196,
      consumedReplay: 0,
      repeats: 0,
      total: 1428,
    });
    expect(existsSync(new URL("development-completion.json.txt", base))).toBe(false);
  });

  test("all published bytes and 26 frozen sources match the actual burned receipt", async () => {
    for (const [name, hash] of Object.entries(result.artifacts)) {
      expect(digest(name)).toBe(hash);
    }
    expect(digest("source-manifest.json.txt")).toBe(result.sourceManifestSha256);
    const manifest = await json<{ sources: { path: string; archive: string; sha256: string }[] }>(
      path("source-manifest.json.txt"),
    );
    const receipt = await json<{ binding: { sources: Record<string, string> } }>(
      path("development-receipt.json.txt"),
    );
    expect(manifest.sources).toHaveLength(26);
    expect(Object.keys(receipt.binding.sources)).toHaveLength(26);
    for (const source of manifest.sources) {
      expect(digest(source.archive)).toBe(source.sha256);
      expect(receipt.binding.sources[source.path]).toBe(source.sha256);
    }
  });

  test("observations are exactly the unchanged fixed dataset prefix with all 51 probabilities", async () => {
    const rows = await json<{ id: string }[]>(path("../recall/calibration-consensus.json.txt"));
    const profile = await json<{ questions: Record<string, unknown> }>(
      path("compiled-profile.json.txt"),
    );
    const ids = Object.keys(profile.questions).toSorted();
    expect(ids).toHaveLength(51);
    expect(observations).toHaveLength(416);
    expect(observations.map((row) => row.id)).toStrictEqual(
      rows.slice(0, 416).map((row) => row.id),
    );
    for (const observation of observations) {
      expect(observation.split).toBe("tuning");
      expect(observation.repeat).toBe(0);
      const probabilities = record(observation.probabilities);
      expect(Object.keys(probabilities).toSorted()).toStrictEqual(ids);
      for (const value of Object.values(probabilities)) {
        const native = numeric(record(value).native);
        expect(Number.isFinite(native)).toBe(true);
        expect(native).toBeGreaterThanOrEqual(0);
        expect(native).toBeLessThanOrEqual(1);
      }
    }
  });

  test("preserves the original ledger prefix and exact cumulative reservations and estimates", async () => {
    const ledger = await json<Ledger>(path("development-ledger.json.txt"));
    const original = await json<Ledger>(path("../recall/development-ledger.json.txt"));
    const added = ledger.attempts.slice(1012);
    expect(ledger.attempts.slice(0, 1012)).toStrictEqual(original.attempts);
    expect(ledger.otherCostNanos).toBe(original.otherCostNanos);
    expect(added).toHaveLength(416);
    expect(added.every((attempt) => attempt.status === "succeeded")).toBe(true);
    expect(added.map((attempt) => attempt.recordId)).toStrictEqual(
      observations.map((row) => `repair/develop/${text(row.id)}/0`),
    );
    expect(added.reduce((sum, attempt) => sum + attempt.reservedNanos, 0)).toBe(
      result.budget.repairReservedNanos,
    );
    expect(added.reduce((sum, attempt) => sum + numeric(attempt.observedNanos), 0)).toBe(
      result.budget.repairObservedTariffNanos,
    );
    expect(ledger.attempts.reduce((sum, attempt) => sum + attempt.reservedNanos, 0)).toBe(
      result.budget.totalReservedNanos,
    );
    expect(result.budget.estimateIsInvoice).toBe(false);
    expect(1428 + 196 + 174).toBe(1798);
    expect(1798 * 2_752_512).toBe(4_949_016_576);
  });
});
