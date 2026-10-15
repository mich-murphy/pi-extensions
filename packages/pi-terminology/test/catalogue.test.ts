import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { criteriaHash, isPolicy, loadCatalogue } from "../catalogue";
import type { Policy } from "../types";
import { composeGlossaries, parseGlossary } from "../validation";
import { expectOk } from "./helpers";
import { historicalPolicy } from "./historical-fixture";

function measured(overrides: Partial<Policy> = {}) {
  const loaded = loadCatalogue();
  const policy: Policy = {
    schemaVersion: 1,
    model: "jev-1.13.0",
    catalogueHash: loaded.catalogue.hash,
    criteriaHash: criteriaHash(loaded.catalogue),
    fixtureHash: "b".repeat(64),
    threshold: 0.95,
    conceptThresholds: Object.fromEntries(
      loaded.catalogue.recognition.map((item) => [item.conceptId, 0.9]),
    ),
    precisionTarget: 0.9,
    measuredDisplayedPrecision: 0.95,
    measured: true,
    ...overrides,
  };
  return { catalogue: loaded.catalogue, policy };
}

function candidateDocument(style: "instructions-focused" | "with-criteria") {
  const text = readFileSync(
    new URL(`../evals/v2/candidates/${style}.json`, import.meta.url),
    "utf8",
  );
  const parsed: unknown = JSON.parse(text);
  return expectOk(parseGlossary(parsed, style, "core"));
}

describe("terminology question candidates", () => {
  test("core and both candidates retain the exact singular and plural PBT aliases", () => {
    const documents = [
      loadCatalogue().catalogue,
      candidateDocument("instructions-focused"),
      candidateDocument("with-criteria"),
    ];
    for (const document of documents) {
      const pbt = document.concepts.find((item) => item.id === "core:property-based-testing");
      expect(pbt?.alternativeLabels).toStrictEqual(["property-based tests", "property-based test"]);
    }
  });

  test("the immutable candidates differ only in recognition question style", () => {
    const instructions = candidateDocument("instructions-focused");
    const criteria = candidateDocument("with-criteria");
    expect(instructions.concepts).toHaveLength(6);
    expect(instructions.recognition).toHaveLength(6);
    expect(instructions.concepts).toStrictEqual(criteria.concepts);
    expect(instructions.recognition.map((item) => item.questionStyle)).toStrictEqual(
      Array.from({ length: 6 }, () => "instructions-focused"),
    );
    expect(criteria.recognition.map((item) => item.questionStyle)).toStrictEqual(
      Array.from({ length: 6 }, () => "with-criteria"),
    );
    expect({
      ...instructions,
      recognition: instructions.recognition.map((item) => ({
        ...item,
        questionStyle: "with-criteria",
      })),
    }).toStrictEqual(criteria);
    const instructionCatalogue = expectOk(composeGlossaries([instructions]));
    const criteriaCatalogue = expectOk(composeGlossaries([criteria]));
    expect(instructionCatalogue.hash).not.toBe(criteriaCatalogue.hash);
    expect(criteriaHash(instructionCatalogue)).not.toBe(criteriaHash(criteriaCatalogue));
    for (const item of instructionCatalogue.recognition) {
      expect(item.question.instructions).toContain(item.matches);
      expect(item.question.instructions).toContain(item.doesNotMatch);
      expect(item.question.criteria).toStrictEqual({
        true: "The request matches.",
        false: "The request does not match.",
      });
    }
    for (const item of criteriaCatalogue.recognition) {
      expect(item.question).toStrictEqual({
        type: "bool",
        instructions: item.matches,
        criteria: { true: item.matches, false: item.doesNotMatch },
      });
    }
  });

  test("both candidates express requested generated-property tests without requiring a counterexample request", () => {
    for (const style of ["instructions-focused", "with-criteria"] as const) {
      const document = candidateDocument(style);
      const pbt = document.recognition.find(
        (item) => item.conceptId === "core:property-based-testing",
      );
      const refactoring = document.recognition.find(
        (item) => item.conceptId === "core:refactoring",
      );
      expect(pbt?.matches).toContain("general correctness properties over generated inputs");
      expect(pbt?.matches).not.toContain("counterexamples");
      expect(pbt?.doesNotMatch).toContain("mutation alone without generated-property tests");
      expect(refactoring?.matches).toContain("actual renaming of code elements");
      expect(refactoring?.doesNotMatch).toContain("documentation-only naming conventions alone");
      for (const item of document.recognition) {
        expect(item.matches).toContain("`prompt` requests");
        expect(item.doesNotMatch).toContain("alone");
      }
    }
  });
});

describe("terminology catalogue policy provenance", () => {
  test("preserves the historical round-two policy and its original 95 percent contract", () => {
    const catalogue = expectOk(composeGlossaries([candidateDocument("with-criteria")]));
    const policy = historicalPolicy(catalogue);
    const loaded = { catalogue, policy };
    expect(loaded.catalogue.concepts).toHaveLength(6);
    expect(loaded.policy.measured).toBe(true);
    expect(isPolicy(loaded.policy, loaded.catalogue)).toBe(true);
    expect(isPolicy({ ...policy, measuredDisplayedPrecision: 0.94 }, catalogue)).toBe(false);
    expect(loaded.policy.threshold).toBe(0.85);
    expect(loaded.policy.measuredDisplayedPrecision).toBeGreaterThanOrEqual(0.95);
    expect(loaded.policy.catalogueHash).toBe(loaded.catalogue.hash);
    expect(loaded.policy.criteriaHash).toBe(criteriaHash(loaded.catalogue));
    const fixtures = readFileSync(new URL("../evals/v2/heldout.json", import.meta.url));
    expect(loaded.policy.fixtureHash).toBe(createHash("sha256").update(fixtures).digest("hex"));
    const report: unknown = JSON.parse(
      readFileSync(
        new URL("../evals/results/2026-10-15-round-2/heldout/run.json", import.meta.url),
        "utf8",
      ),
    );
    expect(report).toMatchObject({
      outcome: "passed",
      requestedModel: loaded.policy.model,
      hashes: {
        catalogue: loaded.policy.catalogueHash,
        criteria: loaded.policy.criteriaHash,
        fixture: loaded.policy.fixtureHash,
      },
      threshold: loaded.policy.threshold,
      thresholdSource: "frozen policy",
      metrics: {
        errors: 0,
        missingAttempts: 0,
        displayed: { tp: 56, fp: 0, fn: 4, precision: 1, recall: 56 / 60 },
      },
    });
    expect(report).toHaveProperty(
      "metrics.displayed.precision",
      loaded.policy.measuredDisplayedPrecision,
    );
  });

  test("accepts an explicit unmeasured pending policy", () => {
    const { catalogue, policy } = measured({
      measured: false,
      catalogueHash: "pending",
      criteriaHash: "pending",
      fixtureHash: "pending",
      threshold: 1,
      measuredDisplayedPrecision: 0,
    });
    expect(policy.measured).toBe(false);
    expect(isPolicy(policy, catalogue)).toBe(true);
  });

  test("requires measured policy hashes and fixture provenance to be exact", () => {
    const { catalogue, policy } = measured();
    expect(isPolicy(policy, catalogue)).toBe(true);
    expect(isPolicy({ ...policy, catalogueHash: "pending" }, catalogue)).toBe(false);
    expect(isPolicy({ ...policy, criteriaHash: "pending" }, catalogue)).toBe(false);
    expect(isPolicy({ ...policy, fixtureHash: "pending" }, catalogue)).toBe(false);
    expect(isPolicy({ ...policy, fixtureHash: "x" }, catalogue)).toBe(false);
    expect(isPolicy({ ...policy, measuredDisplayedPrecision: 0.94 }, catalogue)).toBe(true);
    expect(isPolicy({ ...policy, measuredDisplayedPrecision: 0.89 }, catalogue)).toBe(false);
  });

  test("validates a complete per-concept map independently of the precision target", () => {
    const { catalogue, policy } = measured({ measuredDisplayedPrecision: 0.9 });
    expect(isPolicy(policy, catalogue)).toBe(true);
    expect(isPolicy({ ...policy, conceptThresholds: undefined }, catalogue)).toBe(false);
    expect(
      isPolicy(
        { ...policy, conceptThresholds: { ...policy.conceptThresholds, unknown: 0.9 } },
        catalogue,
      ),
    ).toBe(false);
    expect(
      isPolicy(
        { ...policy, conceptThresholds: { ...policy.conceptThresholds, "core:dead-code": 0 } },
        catalogue,
      ),
    ).toBe(false);
    expect(
      isPolicy(
        {
          ...policy,
          conceptThresholds: { ...policy.conceptThresholds, "core:dead-code": Number.NaN },
        },
        catalogue,
      ),
    ).toBe(false);
    expect(isPolicy({ ...policy, precisionTarget: 0.95 }, catalogue)).toBe(false);
  });
});
