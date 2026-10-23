import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { criteriaHash, isPolicy, loadCatalogue } from "../catalogue";
import { classifierWireQuestions } from "../classifier-request";
import type { Concept, GlossaryDocument } from "../types";
import { composeGlossaries, normalizeLabel, parseGlossary } from "../validation";
import { expectOk } from "./helpers";

const additionIds = [
  "deep-module",
  "information-hiding",
  "make-illegal-states-unrepresentable",
  "parse-dont-validate",
  "branded-types",
  "functional-core-imperative-shell",
  "design-it-twice",
  "characterization-testing",
  "differential-testing",
  "change-detector-test",
  "test-isolation",
  "hermetic-testing",
  "idempotency",
  "blast-radius",
  "ablation-study",
  "progressive-disclosure",
  "dry",
  "yagni",
  "orthogonality",
  "high-cohesion",
  "low-coupling",
  "value-object",
  "regression-testing",
  "contract-testing",
  "fuzzing",
  "debugging-by-bisection",
  "optimistic-concurrency-control",
  "expand-contract-migration",
  "least-privilege",
  "diataxis",
  "anticorruption-layer",
  "metamorphic-testing",
  "delta-debugging",
  "bounded-context",
  "separation-of-concerns",
  "backpressure",
  "exponential-backoff-with-jitter",
  "circuit-breaker",
  "canary-deployment",
  "reconciliation-loop",
  "blinded-evaluation",
].map((id) => `core:${id}`);

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

function document(path: string): GlossaryDocument {
  return expectOk(parseGlossary(readJson(path), path, "core"));
}

const original = document("../evals/production/core.json");
const expanded = document("../glossary/core.json");
const initialExpansion = document("../evals/expansion/source/glossary/core.json.txt");
const catalogue = expectOk(composeGlossaries([expanded]));
const allNames = catalogue.concepts.flatMap((item) => [
  item.label,
  ...(item.alternativeLabels ?? []),
]);

function relatedIds(concept: Concept): readonly string[] {
  return concept.relatedConceptIds ?? [];
}

describe("complete terminology expansion (offline structural checks, not measured recognition)", () => {
  test("archives the original production bytes and validates their historic policy without opening fixtures", () => {
    for (const [path, hash] of [
      [
        "../evals/production/core.json",
        "3247ed281a08a06f0c07c4753d2f30abdb5c54998fbe2aadce89770fc4efb357",
      ],
      [
        "../evals/production/policy.json",
        "ad6eff4a99ee336937e5b661a1712bd61089765b5e5bcd85b1bf5de3d4d0979b",
      ],
    ] as const) {
      const bytes = readFileSync(new URL(path, import.meta.url));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
    }
    expect(original.concepts).toHaveLength(10);
    const historicCatalogue = expectOk(composeGlossaries([original]));
    const historicPolicy = readJson("../evals/production/policy.json");
    expect(isPolicy(historicPolicy, historicCatalogue)).toBe(true);
    expect(isPolicy(historicPolicy, catalogue)).toBe(false);
    expect(historicPolicy).toMatchObject({ measured: true, precisionTarget: 0.9 });
  });

  test("adds exactly the 30 main and 11 backlog concepts, preserving all ten original records", () => {
    expect(additionIds).toHaveLength(41);
    expect(expanded.concepts).toHaveLength(51);
    expect(expanded.recognition).toHaveLength(51);
    expect(expanded.concepts.slice(0, 10)).toStrictEqual(original.concepts);
    expect(expanded.concepts).toStrictEqual(initialExpansion.concepts);
    expect(initialExpansion.recognition.slice(0, 10)).toStrictEqual(original.recognition);
    expect(expanded.concepts.slice(10).map((item) => item.id)).toStrictEqual(additionIds);
    expect(new Set(expanded.recognition.map((item) => item.conceptId))).toStrictEqual(
      new Set(expanded.concepts.map((item) => item.id)),
    );
  });

  test("publishes exactly the full concept metadata, with no recognizer material for blind fixture authors", () => {
    const metadata = readJson("../evals/expansion/concepts.json");
    expect(metadata).toStrictEqual({
      schemaVersion: 1,
      namespace: "core",
      concepts: expanded.concepts,
    });
    const definitionOnly = expectOk(
      parseGlossary({ ...expanded, recognition: [] }, "definitions-only", "core"),
    );
    expect(expectOk(composeGlossaries([definitionOnly])).concepts).toHaveLength(51);
  });

  test("gives each addition source-backed scope and only resolvable, distinct related meanings", () => {
    const allIds = new Set(catalogue.concepts.map((item) => item.id));
    expect(new Set(allNames.map((name) => normalizeLabel(name))).size).toBe(allNames.length);
    for (const item of expanded.concepts.slice(10)) {
      expect(item.scopeNote?.trim().length).toBeGreaterThan(0);
      expect(item.references.length).toBeGreaterThan(0);
      for (const reference of item.references) {
        expect(reference.kind).toBe("web");
        expect(reference.url).toMatch(/^https:\/\//u);
      }
      for (const related of relatedIds(item)) {
        expect(related).not.toBe(item.id);
        expect(allIds.has(related)).toBe(true);
      }
    }
  });

  test("preserves the original expansion's named bounded profiles independently of later repairs", () => {
    const historical = expectOk(composeGlossaries([initialExpansion]));
    const wire = classifierWireQuestions(historical);
    expect(Object.keys(wire)).toHaveLength(51);
    for (const item of historical.recognition.filter((entry) =>
      additionIds.includes(entry.conceptId),
    )) {
      expect(item.questionStyle).toBe("named");
      expect(item.classifierAliases).toBeUndefined();
      expect(item.question.instructions).toContain(item.concept.label);
      expect(item.question.instructions).toContain("current, real work");
      expect(item.question.instructions).toContain("Hypothetical or illustrative examples");
      expect(item.question.instructions).toContain("research about a practice");
      expect(item.question.criteria.true).toContain(item.matches);
      expect(item.question.criteria.false).toContain(item.doesNotMatch);
      expect(item.doesNotMatch).toContain("negated approaches");
      expect(item.doesNotMatch).toContain("quoted instructions");
      expect(wire[item.conceptId]).toMatchObject({
        type: "noul",
        criteria: item.question.criteria,
      });
    }
  });

  test("keeps canonical scope and problematic-test labels separate from the requested actions", () => {
    const blast = catalogue.recognition.find((item) => item.conceptId === "core:blast-radius");
    expect(blast?.concept.definition).toMatch(/^The scope of effects/u);
    expect(blast?.matches).toContain("investigate how far");
    expect(blast?.concept.alternativeLabels).toBeUndefined();
    expect(blast?.concept.scopeNote).toContain("not unrestricted synonyms");
    const detector = catalogue.recognition.find(
      (item) => item.conceptId === "core:change-detector-test",
    );
    expect(detector?.concept.definition).toMatch(/^A test that reproduces/u);
    expect(detector?.matches).toContain("identify or replace a test");
    expect(detector?.doesNotMatch).toContain("Generic requests for behavior-focused tests");
    expect(detector?.doesNotMatch).toContain(
      "interaction assertions whose sequence is required behavior",
    );
    expect(detector?.concept.alternativeLabels).toBeUndefined();
  });

  test("leaves the expanded catalogue unmeasured with current hashes and no borrowed cutoffs or evidence", () => {
    const loaded = loadCatalogue();
    const policy = readJson("../glossary/policy.json");
    expect(loaded.ok).toBe(true);
    expect(loaded.catalogue.hash).toBe(catalogue.hash);
    expect(isPolicy(policy, catalogue)).toBe(true);
    expect(loaded.policy).toStrictEqual(policy);
    expect(policy).toStrictEqual({
      schemaVersion: 1,
      model: "jev-1.13.0",
      catalogueHash: catalogue.hash,
      criteriaHash: criteriaHash(catalogue),
      fixtureHash: "pending",
      threshold: 1,
      precisionTarget: 0.9,
      measuredDisplayedPrecision: 0,
      measured: false,
    });
  });
});
