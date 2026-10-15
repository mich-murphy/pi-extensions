import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { criteriaHash, isPolicy, loadCatalogue } from "../catalogue";
import { JEV_MODEL_ID } from "../classifier-request";
import { computeRealPromptMetrics } from "../real-prompt-metrics";
import type { RealPromptGold, RealPromptObservation } from "../real-prompt-metrics";
import { stableHash } from "../validation";

const directory = new URL("../evals/production/", import.meta.url);
const manifestBytes = readFileSync(new URL("manifest.json", directory));
const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
const report = readJSON("report.json");
const fixtures = array(readJSON("synthetic-fixtures.json")).map((value) => gold(value));
const observations = readFileSync(new URL("synthetic-observations.jsonl", directory), "utf8")
  .trim()
  .split("\n")
  .map((line) => {
    const value: unknown = JSON.parse(line);
    return observation(value);
  });
const loaded = loadCatalogue();
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function readJSON(name: string): unknown {
  const value: unknown = JSON.parse(readFileSync(new URL(name, directory), "utf8"));
  return value;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function property(value: unknown, ...keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    current = record(current) ? current[key] : undefined;
  }
  return current;
}
function entries(value: unknown): [string, unknown][] {
  if (!record(value)) {
    throw new Error("Invalid evidence object.");
  }
  return Object.entries(value);
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid evidence array.");
  }
  return value.map((item: unknown) => item);
}
function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Invalid evidence string.");
  }
  return value;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Missing committed production evidence.");
  }
  return value;
}
function gold(value: unknown): RealPromptGold {
  const named = new Set(array(property(value, "named")).map((item) => text(item)));
  return {
    id: text(property(value, "id")),
    split: "heldout",
    labels: Object.fromEntries(
      entries(property(value, "labels")).map(([id, label]) => {
        if (label !== "positive" && label !== "negative" && label !== "ambiguous") {
          throw new Error("Invalid evidence gold label.");
        }
        return [id, { label, named: named.has(id) }];
      }),
    ),
  };
}
function observation(value: unknown): RealPromptObservation {
  if (property(value, "split") !== "heldout" || property(value, "repeat") !== 0) {
    throw new Error("Invalid evidence observation split/repeat.");
  }
  return {
    id: text(property(value, "id")),
    split: "heldout",
    repeat: 0,
    alreadyNamed: array(property(value, "alreadyNamed")).map((item) => text(item)),
    probabilities: Object.fromEntries(
      entries(property(value, "probabilities")).map(([id, variants]) => [
        id,
        Object.fromEntries(
          entries(variants).map(([variant, probability]) => {
            if (typeof probability !== "number") {
              throw new TypeError("Invalid evidence probability.");
            }
            return [variant, probability];
          }),
        ),
      ]),
    ),
  };
}

describe("committed production evidence (offline only)", () => {
  test("binds the measured policy to the exact manifest, source catalogue and wire questions", () => {
    expect(loaded.ok).toBe(true);
    expect(loaded.policy.measured).toBe(true);
    expect(loaded.policy.model).toBe(JEV_MODEL_ID);
    expect(loaded.policy.precisionTarget).toBe(0.9);
    expect(isPolicy(loaded.policy, loaded.catalogue)).toBe(true);
    expect(loaded.policy.fixtureHash).toBe(sha(manifestBytes));
    expect(loaded.policy.catalogueHash).toBe(loaded.catalogue.hash);
    expect(loaded.policy.criteriaHash).toBe(criteriaHash(loaded.catalogue));
    expect(loaded.policy.conceptThresholds).toStrictEqual(
      property(manifest, "protocol", "frozenProbabilityThresholds"),
    );
    expect(report).toMatchObject({
      outcome: "passed",
      plannedCalls: 360,
      repeats: 1,
      retries: 0,
      precisionTarget: 0.9,
      policyWritten: true,
      provenance: {
        manifestHash: loaded.policy.fixtureHash,
        catalogueHash: loaded.catalogue.hash,
        catalogueSnapshot: stableHash(loaded.catalogue),
        criteriaHash: criteriaHash(loaded.catalogue),
        policyHash: stableHash({
          ...loaded.policy,
          measured: false,
          measuredDisplayedPrecision: 0,
        }),
        conceptThresholds: loaded.policy.conceptThresholds,
      },
    });
    expect(loaded.policy.measuredDisplayedPrecision).toBe(
      property(report, "metrics", "overall", "overall", "precision"),
    );
  });

  test.each(entries(property(manifest, "protocol", "sourceHashes")))(
    "preserves frozen production source %s",
    (path, expected) => {
      expect(sha(readFileSync(new URL(`../${path}`, import.meta.url)))).toBe(expected);
    },
  );

  test("matches the public dataset commitment and withholds every private observation", () => {
    const publicDataset = array(property(manifest, "datasets")).find(
      (dataset) => property(dataset, "kind") === "synthetic",
    );
    expect(sha(readFileSync(new URL("synthetic-fixtures.json", directory)))).toBe(
      property(publicDataset, "sha256"),
    );
    expect(property(publicDataset, "records")).toBe(80);
    expect(fixtures).toHaveLength(80);
    expect(observations).toHaveLength(80);
    expect(observations.map((item) => item.id)).toStrictEqual(
      fixtures.map((fixture) => fixture.id),
    );
  });

  test("exactly replays every published synthetic aggregate, including the redundant reminder error", () => {
    const concepts = loaded.catalogue.concepts.map(({ id }) => ({ id, variants: ["production"] }));
    const metrics = computeRealPromptMetrics(
      { split: "heldout", repeats: 1, concepts, observations, gold: fixtures },
      Object.fromEntries(
        concepts.map(({ id }) => [
          id,
          {
            enabled: true,
            variant: "production",
            threshold: required(loaded.policy.conceptThresholds?.[id]),
          },
        ]),
      ),
    );
    expect(property(report, "metrics", "synthetic", "overall")).toStrictEqual(metrics.overall);
    expect(property(report, "metrics", "synthetic", "perConcept")).toStrictEqual(
      Object.fromEntries(
        Object.entries(metrics.perConcept).map(([id, value]) => {
          const { distinctPromptEvidence: _evidence, ...aggregate } = value;
          return [id, aggregate];
        }),
      ),
    );
    expect(metrics.overall).toMatchObject({
      tp: 41,
      fp: 1,
      fn: 3,
      redundantReminderFp: 1,
      ambiguousHits: 0,
    });
    expect(property(report, "metrics", "overall", "overall", "precision")).toBeGreaterThanOrEqual(
      0.9,
    );
    expect(property(report, "metrics", "private", "overall", "precision")).toBeGreaterThanOrEqual(
      0.9,
    );
  });
});
