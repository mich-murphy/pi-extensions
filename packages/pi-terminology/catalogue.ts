import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLASSIFIER_REQUEST_PROFILE,
  classifierWireQuestions,
  hasClassifierProfiles,
} from "./classifier-request";
import type { Catalogue, GlossaryDocument, Policy } from "./types";
import { composeGlossaries, parseGlossary, stableHash } from "./validation";

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const CORE_PATH = join(PACKAGE_DIR, "glossary", "core.json");
const POLICY_PATH = join(PACKAGE_DIR, "glossary", "policy.json");

export type CatalogueLoadResult =
  | {
      readonly ok: true;
      readonly catalogue: Catalogue;
      readonly policy: Policy;
      readonly warning?: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly catalogue: Catalogue;
      readonly policy: Policy;
    };

export function loadCatalogue(projectText?: string): CatalogueLoadResult {
  const core = readDocument(CORE_PATH, "core glossary");
  const fallback = composeOrThrow([core]);
  const policy = readPolicy(fallback);
  const documents: GlossaryDocument[] = [core];
  let warning: string | undefined;
  if (projectText !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(projectText);
    } catch {
      warning = "Project terminology glossary is not valid JSON; using the bundled core glossary.";
    }
    if (parsed !== undefined) {
      const result = parseGlossary(parsed, "project glossary", "project");
      if (result.ok) {
        documents.push(result.value);
      } else {
        warning = `${result.errors.join("\n")}\nUsing the bundled core glossary.`;
      }
    }
  }
  const composed = composeGlossaries(documents);
  if (!composed.ok) {
    return {
      ok: false,
      error: `${composed.errors.join("\n")}\nUsing the bundled core glossary.`,
      catalogue: fallback,
      policy,
    };
  }
  if (policy.catalogueHash !== "pending" && policy.catalogueHash !== fallback.hash) {
    return {
      ok: false,
      error:
        "Terminology policy was measured against a different core glossary; automatic reminders are disabled.",
      catalogue: fallback,
      policy,
    };
  }
  const effectivePolicy = composed.value.hash === fallback.hash ? policy : unmeasuredPolicy();
  const projectWarning =
    composed.value.hash === fallback.hash
      ? warning
      : joinWarnings(
          warning,
          "Project terminology criteria have not been measured; automatic reminders are disabled for this composed catalogue.",
        );
  return projectWarning === undefined
    ? { ok: true, catalogue: composed.value, policy: effectivePolicy }
    : { ok: true, catalogue: composed.value, policy: effectivePolicy, warning: projectWarning };
}

function joinWarnings(left: string | undefined, right: string): string {
  return left === undefined ? right : `${left}\n${right}`;
}

export function criteriaHash(catalogue: Catalogue): string {
  if (hasClassifierProfiles(catalogue)) {
    return stableHash({
      profile: CLASSIFIER_REQUEST_PROFILE,
      questions: classifierWireQuestions(catalogue),
    });
  }
  // Preserve historical policy/archive hashes for legacy-only catalogues.
  return stableHash(catalogue.recognition.map((item) => [item.conceptId, item.question]));
}

function readDocument(path: string, source: string): GlossaryDocument {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const result = parseGlossary(parsed, source, "core");
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }
  return result.value;
}

function readPolicy(coreCatalogue: Catalogue): Policy {
  const value = JSON.parse(readFileSync(POLICY_PATH, "utf8")) as unknown;
  if (isPolicy(value, coreCatalogue)) {
    return value;
  }
  return unmeasuredPolicy();
}

function composeOrThrow(documents: readonly GlossaryDocument[]): Catalogue {
  const result = composeGlossaries(documents);
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }
  return result.value;
}

export function isPolicy(value: unknown, coreCatalogue: Catalogue): value is Policy {
  return (
    isRecord(value) &&
    hasPolicyShape(value) &&
    hasCurrentHashes(value, coreCatalogue) &&
    hasConceptThresholds(value, coreCatalogue) &&
    hasMeasuredPolicyProvenance(value)
  );
}

function hasPolicyShape(value: Record<string, unknown>): value is Policy {
  return (
    value.schemaVersion === 1 &&
    value.model === "jev-1.13.0" &&
    typeof value.catalogueHash === "string" &&
    typeof value.criteriaHash === "string" &&
    typeof value.fixtureHash === "string" &&
    isProbability(value.threshold) &&
    isProbability(value.measuredDisplayedPrecision) &&
    (value.precisionTarget === undefined ||
      (isProbability(value.precisionTarget) && value.precisionTarget >= 0.9)) &&
    typeof value.measured === "boolean"
  );
}

function hasCurrentHashes(value: Policy, coreCatalogue: Catalogue): boolean {
  if (value.measured) {
    return (
      value.catalogueHash === coreCatalogue.hash &&
      value.criteriaHash === criteriaHash(coreCatalogue)
    );
  }
  return (
    (value.catalogueHash === "pending" || value.catalogueHash === coreCatalogue.hash) &&
    (value.criteriaHash === "pending" || value.criteriaHash === criteriaHash(coreCatalogue))
  );
}

function hasConceptThresholds(value: Policy, catalogue: Catalogue): boolean {
  const thresholds = value.conceptThresholds;
  if (thresholds === undefined) {
    return !value.measured || !hasClassifierProfiles(catalogue);
  }
  return (
    isRecord(thresholds) &&
    Object.keys(thresholds).length === catalogue.recognition.length &&
    catalogue.recognition.every((item) => {
      const cutoff = thresholds[item.conceptId];
      return Object.hasOwn(thresholds, item.conceptId) && isProbability(cutoff) && cutoff > 0;
    })
  );
}

function hasMeasuredPolicyProvenance(value: Policy): boolean {
  if (!value.measured) {
    return true;
  }
  // An omitted target retains the historical policy contract, including archived policies.
  return (
    value.measuredDisplayedPrecision >= (value.precisionTarget ?? 0.95) &&
    /^[0-9a-f]{64}$/u.test(value.fixtureHash)
  );
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function unmeasuredPolicy(): Policy {
  return {
    schemaVersion: 1,
    model: "jev-1.13.0",
    catalogueHash: "pending",
    criteriaHash: "pending",
    fixtureHash: "pending",
    threshold: 1,
    measuredDisplayedPrecision: 0,
    measured: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
