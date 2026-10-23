import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { criteriaHash } from "../catalogue";
import { computeRealPromptMetrics } from "../real-prompt-metrics";
import type { RealPromptGold, RealPromptObservation } from "../real-prompt-metrics";
import { composeGlossaries, parseGlossary } from "../validation";

const directory = new URL("../evals/expansion/", import.meta.url);
const bytes = (name: string) => readFileSync(new URL(name, directory));
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function json(name: string): unknown {
  return JSON.parse(bytes(name).toString("utf8"));
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
    throw new TypeError("Expected an evidence record");
  }
  return Object.entries(value);
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Expected an evidence array");
  }
  return value.map((item: unknown) => item);
}
function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Expected an evidence string");
  }
  return value;
}
function probability(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError("Expected a probability");
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
          throw new TypeError("Invalid reference label");
        }
        return [id, { label, named: named.has(id) }];
      }),
    ),
  };
}
function observation(value: unknown): RealPromptObservation {
  const row = property(value, "observation");
  const repeat = property(row, "repeat");
  if (property(row, "split") !== "heldout" || (repeat !== 0 && repeat !== 1)) {
    throw new TypeError("Invalid diagnostic observation");
  }
  return {
    id: text(property(row, "id")),
    split: "heldout",
    repeat,
    alreadyNamed: array(property(row, "alreadyNamed")).map((item) => text(item)),
    probabilities: Object.fromEntries(
      entries(property(row, "probabilities")).map(([id, variants]) => [
        id,
        { native: probability(property(variants, "native")) },
      ]),
    ),
  };
}

function historicalCatalogue() {
  const parsed = parseGlossary(json("source/glossary/core.json.txt"), "archived expansion", "core");
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }
  const composed = composeGlossaries([parsed.value]);
  if (!composed.ok) {
    throw new Error(composed.errors.join("\n"));
  }
  return composed.value;
}

const report = json("development-report.json.txt");
const frozen = json("frozen-cutoffs.json");

describe("fresh expansion development evidence, not production approval", () => {
  test("retains exact native development artifact bytes and the original frozen manifest", () => {
    expect(sha(bytes("development-report.json.txt"))).toBe(property(frozen, "tuningReport"));
    expect(sha(bytes("development-observations.json.txt"))).toBe(
      property(frozen, "tuningObservations"),
    );
    expect(sha(bytes("manifest.json"))).toBe(property(frozen, "binding", "manifest"));
    expect(property(report, "binding")).toStrictEqual(property(frozen, "binding"));
    expect(property(report, "thresholds")).toStrictEqual(property(frozen, "thresholds"));
  });

  test("binds the development run to the complete catalogue, questions and source files", () => {
    const catalogue = historicalCatalogue();
    expect(catalogue.concepts).toHaveLength(51);
    expect(catalogue.recognition).toHaveLength(51);
    expect(criteriaHash(catalogue)).toBe(property(frozen, "binding", "criteria"));
    for (const [path, hash] of entries(property(frozen, "binding", "sources"))) {
      expect(sha(bytes(`source/${path}.txt`))).toBe(hash);
    }
    expect(entries(property(frozen, "thresholds"))).toHaveLength(51);
    expect(property(json("source/glossary/policy.json.txt"), "measured")).toBe(false);
  });

  test("preserves published diagnostic artifacts without treating them as acceptance", () => {
    const result = json("result.json");
    for (const [name, hash] of entries(property(result, "publishedArtifacts"))) {
      expect(sha(bytes(name))).toBe(hash);
    }
    expect(result).toMatchObject({
      cleanAcceptance: false,
      policyWritten: false,
      experimentAttempts: 359,
      privateUsefulPrompts: {
        expandedTuned: 4,
        oldTenSubset: 6,
        gain: -2,
        newConceptTruePositives: 0,
      },
    });
    expect(json("diagnostic-report.json.txt")).toMatchObject({
      outcome: "diagnostic-only",
      complete: true,
      originalAcceptanceBlocked: true,
      policyWritten: false,
      policyUnchanged: true,
      usefulPrivatePromptGain: -2,
      syntheticRecallGate: false,
      metrics: {
        overall: { overall: { tp: 95, fp: 4, fn: 48 } },
        private: { overall: { tp: 4, fp: 0, fn: 6 } },
      },
      budget: { attempts: 359, jevReservedNanos: 988_151_808 },
    });
  });

  test("replays all public synthetic diagnostic scores while withholding private observations", () => {
    const fixtures = array(json("heldout-synthetic-consensus.json.txt")).map((item) => gold(item));
    const observations = bytes("synthetic-observations.jsonl")
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => observation(JSON.parse(line)));
    const publicIds = new Set(fixtures.map((f) => f.id));
    expect(fixtures).toHaveLength(148);
    expect(observations).toHaveLength(160);
    expect(observations.every((o) => publicIds.has(o.id))).toBe(true);
    const thresholds = Object.fromEntries(
      entries(property(frozen, "thresholds")).map(([id, value]) => [
        id,
        { enabled: true as const, variant: "native", threshold: probability(value) },
      ]),
    );
    const metrics = computeRealPromptMetrics(
      {
        split: "heldout",
        repeats: 1,
        concepts: historicalCatalogue().concepts.map(({ id }) => ({
          id,
          variants: ["native"],
        })),
        gold: fixtures,
        observations: observations.filter((o) => o.repeat === 0),
      },
      thresholds,
    );
    const diagnostic = json("diagnostic-report.json.txt");
    expect(metrics.overall).toStrictEqual(property(diagnostic, "metrics", "synthetic", "overall"));
    expect(metrics.perConcept).toStrictEqual(
      property(diagnostic, "metrics", "synthetic", "perConcept"),
    );
  });

  test("reports tuned in-sample recognition honestly, with ambiguity and a bounded budget", () => {
    expect(report).toMatchObject({
      outcome: "tuned",
      completedAttempts: 120,
      plannedAttempts: 120,
      gaps: [],
      errors: [],
      policyWritten: false,
      metrics: {
        overall: { tp: 172, fp: 0, fn: 17, ambiguousHits: 3, precision: 1 },
      },
      budget: { attempts: 120, jevReservedNanos: 330_301_440 },
      latency: { dispatchedAttempts: 120, completedWithin5s: 120, failedAttempts: 0 },
    });
    expect(property(report, "fixedDevelopmentComparators", "0.9", "overall", "fp")).toBe(13);
    expect(property(report, "fixedDevelopmentComparators", "0.95", "overall", "fn")).toBe(39);
  });
});
