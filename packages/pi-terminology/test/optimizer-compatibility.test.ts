import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { check } from "../scripts/recall-contract";
import { stableHash } from "../validation";

type Reader = (path: string) => string;
const base = new URL("../", import.meta.url);
const read: Reader = (path) => readFileSync(new URL(path, base), "utf8");
const attestationPath = "evals/repair/preview/optimizer-compatibility/attestation.json";
const files = {
  originalFitter: "evals/repair/source/recall-aggregate-calibration.ts.txt",
  currentFitter: "recall-aggregate-calibration.ts",
  compatibilityRule: "scripts/command-rename-compatibility.ts",
  publisher: "scripts/publish-repair-preview.ts",
  historicalPublication: "evals/repair/preview/command-rename/publication.json",
  nativeResult: "evals/repair/continuation/result.json",
  completion: "evals/repair/continuation/combined-completion.json.txt",
  report: "evals/repair/continuation/report.json.txt",
  dataset: "evals/recall/calibration-consensus.json.txt",
  originalObservations: "evals/repair/development-observations.jsonl",
  continuationObservations: "evals/repair/continuation/observations.jsonl",
  fitSeal: "evals/repair/continuation/fit-seal.json.txt",
  previewPolicy: "glossary/preview-policy.json",
};
function verifyAttestation(reader: Reader) {
  const completion: unknown = JSON.parse(reader(files.completion));
  check(
    typeof completion === "object" &&
      completion !== null &&
      "combinedObservationsHash" in completion &&
      "orderedIdsHash" in completion,
    "Missing completion seals.",
  );
  const actual: unknown = JSON.parse(reader(attestationPath));
  const expected = {
    schemaVersion: 1,
    kind: "offline-optimizer-source-compatibility",
    measured: false,
    accepted: false,
    promotable: false,
    freshInference: false,
    nativeCalls: 0,
    activationPerformed: false,
    globalSettingsChanged: false,
    serializedFitSha256: "81154dd0738a4020a5a3c7db1445369821e278dfe7409c744e64798f660d2e17",
    combinedObservationsHash: completion.combinedObservationsHash,
    orderedIdsHash: completion.orderedIdsHash,
    files: Object.fromEntries(
      Object.entries(files).map(([name, path]) => [
        name,
        { path, sha256: createHash("sha256").update(reader(path)).digest("hex") },
      ]),
    ),
  };
  check(stableHash(actual) === stableHash(expected), "Offline optimizer attestation mismatch.");
}
function withFiles(overrides: Record<string, string>): Reader {
  return (path) => overrides[path] ?? read(path);
}

describe("versioned offline optimizer compatibility attestation", () => {
  test("binds current source and unchanged native evidence without replacing the historical publication", () => {
    expect(() => {
      verifyAttestation(read);
    }).not.toThrow();
  });
  test.each(Object.values(files))("rejects a changed binding for %s", (path) => {
    expect(() => {
      verifyAttestation(withFiles({ [path]: `${read(path)}\n` }));
    }).toThrow("Offline optimizer attestation mismatch");
  });
  test.each([
    ["wrong source path", '"recall-aggregate-calibration.ts"', '"index.ts"'],
    ["wrong fit digest", "81154dd0738a4020", "0000000000000000"],
    ["false acceptance", '"accepted": false', '"accepted": true'],
    ["new inference", '"freshInference": false', '"freshInference": true'],
    ["wrong combined seal", "96ec0fba84c59688", "0000000000000000"],
  ])("rejects attestation mutation: %s", (_name, before, after) => {
    expect(() => {
      verifyAttestation(
        withFiles({ [attestationPath]: read(attestationPath).replace(before, after) }),
      );
    }).toThrow("Offline optimizer attestation mismatch");
  });
});
