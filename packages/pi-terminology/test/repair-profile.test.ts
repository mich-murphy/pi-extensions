import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { criteriaHash, isPolicy, loadCatalogue } from "../catalogue";
import { CLASSIFIER_REQUEST_PROFILE, classifierWireQuestions } from "../classifier-request";
import { parseGlossary } from "../validation";
import { expectOk } from "./helpers";

function bytes(path: string) {
  return readFileSync(new URL(path, import.meta.url));
}
function document(path: string) {
  const value: unknown = JSON.parse(bytes(path).toString("utf8"));
  return expectOk(parseGlossary(value, path, "core"));
}
const prior = document("../evals/recall/semantic-repair-core.json");
const candidate = document("../evals/repair/recognition-core.json");
const changedIds = ["core:low-coupling", "core:refactoring", "core:separation-of-concerns"];

describe("manual-preview recognition repair lineage", () => {
  test("the predeclared profile is exactly the runtime core, not a per-request mixture", () => {
    expect(bytes("../glossary/core.json")).toStrictEqual(
      bytes("../evals/repair/recognition-core.json"),
    );
    expect(createHash("sha256").update(bytes("../glossary/core.json")).digest("hex")).toBe(
      "bdc30977310ec5861d5ba53f36f7c89d6a00bab026e0b598b7da56a5a7e63a65",
    );
    expect(candidate.concepts).toHaveLength(51);
    expect(candidate.recognition).toHaveLength(51);
  });

  test("all meanings, aliases and provenance are unchanged; only three recognizers differ", () => {
    expect(candidate.concepts).toStrictEqual(prior.concepts);
    expect(
      candidate.recognition
        .filter((item, index) => JSON.stringify(item) !== JSON.stringify(prior.recognition[index]))
        .map((item) => item.conceptId)
        .toSorted(),
    ).toStrictEqual(changedIds);
    const unaffected = (items: typeof candidate.recognition) =>
      items.filter((item) => !changedIds.includes(item.conceptId));
    expect(unaffected(candidate.recognition)).toStrictEqual(unaffected(prior.recognition));
  });

  test("all 51 actual wire questions retain real-work scope and the three repairs inline exclusions", () => {
    const loaded = loadCatalogue();
    expect(loaded.ok).toBe(true);
    expect(CLASSIFIER_REQUEST_PROFILE.version).toBe(2);
    const wire = classifierWireQuestions(loaded.catalogue);
    expect(Object.keys(wire)).toHaveLength(51);
    for (const item of loaded.catalogue.recognition) {
      expect(wire[item.conceptId]).toMatchObject({ type: "noul" });
      expect(wire[item.conceptId]?.instructions).toContain("current, real work");
      expect(wire[item.conceptId]?.instructions).toContain("Hypothetical or illustrative");
    }
    for (const item of loaded.catalogue.recognition.filter((r) =>
      changedIds.includes(r.conceptId),
    )) {
      expect(item.questionStyle).toBe("instructions-focused");
      expect(item.question.instructions).toContain(item.matches);
      expect(item.question.instructions).toContain(item.doesNotMatch);
      expect(item.question.instructions).toContain("Non-matching boundary");
    }
  });

  test("the production policy stays unmeasured and correctly bound, with no borrowed cutoffs", () => {
    const loaded = loadCatalogue();
    expect(loaded.policy).toMatchObject({
      model: "jev-1.13.0",
      catalogueHash: loaded.catalogue.hash,
      criteriaHash: criteriaHash(loaded.catalogue),
      measured: false,
      threshold: 1,
      measuredDisplayedPrecision: 0,
      fixtureHash: "pending",
    });
    expect(loaded.policy.conceptThresholds).toBeUndefined();
    expect(isPolicy(loaded.policy, loaded.catalogue)).toBe(true);
  });
});
