import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import {
  CLASSIFIER_REQUEST_PROFILE,
  JEV_MODEL_ID,
  classifierWireQuestions,
  classifierState,
} from "./classifier-request";
import type { Catalogue } from "./types";
import { stableHash } from "./validation";

export const PREVIEW_CALL_BOUND_USD = (65_536 * 0.042) / 1e6;
export const PREVIEW_MAX_WIRE_BYTES = 63 * 1024;

/** Whole native wire envelope; reserve another 1024 tokens for special-token overhead. */
export function previewRequestFits(catalogue: Catalogue, prompt: string): boolean {
  return (
    Buffer.byteLength(
      JSON.stringify({
        model: JEV_MODEL_ID,
        state: classifierState(catalogue, prompt),
        questions: classifierWireQuestions(catalogue),
      }),
      "utf8",
    ) <= PREVIEW_MAX_WIRE_BYTES
  );
}
export type PreviewBinding = {
  readonly model: typeof JEV_MODEL_ID;
  readonly catalogueHash: string;
  readonly wireCriteriaHash: string;
  readonly profileHash: string;
  readonly sourceHashes: Readonly<Record<string, string>>;
};
export type PreviewPolicy = PreviewBinding & {
  readonly schemaVersion: 1;
  readonly developmentOnly: true;
  readonly measured: false;
  readonly promotable: false;
  readonly acceptanceStatus: "not-validated";
  readonly conceptThresholds: Readonly<Record<string, number>>;
  readonly gaps: readonly string[];
};
export type PreviewAvailability =
  | { readonly ok: true; readonly policy: PreviewPolicy }
  | { readonly ok: false; readonly reason: string };

/** Capture after runtime sources are final. Full catalogue, actual wire and extraction/native sources. */
export function previewBinding(catalogue: Catalogue): PreviewBinding {
  return {
    model: JEV_MODEL_ID,
    catalogueHash: stableHash({ concepts: catalogue.concepts, recognition: catalogue.recognition }),
    wireCriteriaHash: stableHash(classifierWireQuestions(catalogue)),
    profileHash: stableHash(CLASSIFIER_REQUEST_PROFILE),
    sourceHashes: Object.fromEntries(
      [
        "index.ts",
        "selection.ts",
        "ui.ts",
        "preview-policy.ts",
        "classifier-request.ts",
        "native-matcher.ts",
      ].map((name) => [name, stableHash(readFileSync(new URL(name, import.meta.url), "utf8"))]),
    ),
  };
}

/** Pure validator; binding is supplied explicitly so evaluation need not read runtime files. */
export function validatePreviewPolicy(
  value: unknown,
  catalogue: Catalogue,
  binding: PreviewBinding,
): PreviewAvailability {
  if (!isRecord(value)) {
    return unavailable();
  }
  const v = value;
  if (
    v.schemaVersion !== 1 ||
    v.developmentOnly !== true ||
    v.measured !== false ||
    v.promotable !== false ||
    v.acceptanceStatus !== "not-validated" ||
    !Array.isArray(v.gaps) ||
    v.gaps.length === 0 ||
    !v.gaps.every((gap) => typeof gap === "string" && gap.trim().length > 0)
  ) {
    return unavailable();
  }
  for (const key of [
    "model",
    "catalogueHash",
    "wireCriteriaHash",
    "profileHash",
    "sourceHashes",
  ] as const) {
    if (v[key] === undefined || stableHash(v[key]) !== stableHash(binding[key])) {
      return unavailable();
    }
  }
  const thresholds = v.conceptThresholds;
  if (!isRecord(thresholds)) {
    return unavailable();
  }
  const cutoffs = thresholds;
  if (
    Object.keys(cutoffs).length !== catalogue.recognition.length ||
    !catalogue.recognition.every(
      (item) =>
        Object.hasOwn(cutoffs, item.conceptId) &&
        typeof cutoffs[item.conceptId] === "number" &&
        Number.isFinite(cutoffs[item.conceptId]) &&
        isCutoff(cutoffs[item.conceptId]),
    )
  ) {
    return unavailable();
  }
  return {
    ok: true,
    policy: {
      ...binding,
      schemaVersion: 1,
      developmentOnly: true,
      measured: false,
      promotable: false,
      acceptanceStatus: "not-validated",
      gaps: v.gaps.filter((gap): gap is string => typeof gap === "string"),
      conceptThresholds: Object.fromEntries(
        Object.entries(cutoffs).filter((entry): entry is [string, number] => isCutoff(entry[1])),
      ),
    },
  };
}

export function loadPreviewPolicy(catalogue: Catalogue): PreviewAvailability {
  try {
    return validatePreviewPolicy(
      JSON.parse(readFileSync(new URL("glossary/preview-policy.json", import.meta.url), "utf8")),
      catalogue,
      previewBinding(catalogue),
    );
  } catch {
    return {
      ok: false,
      reason: "Preview candidate is missing or unreadable; experimental reminders unavailable.",
    };
  }
}
function unavailable(): PreviewAvailability {
  return {
    ok: false,
    reason: "Preview candidate is incompatible or mutated; experimental reminders unavailable.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isCutoff(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1;
}
