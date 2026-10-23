import { dirname, resolve } from "node:path";
import type { Ledger } from "../eval-budget";
import { stableHash } from "../validation";
import { check, hashFile, json, readRecallFixtures } from "./recall-contract";
import type { RecallEntry } from "./recall-contract";

export const ORIGINAL_LEDGER_HASH =
  "272d9e60ad7d15ad540522f4ba0bb47b4411d71bcc26f579ff3787eb0f1067db";
const DEVELOPMENT_HASH = "a476109e901b90f9f1aa8904f09072ed173170884a521a3a494211d893ebb8f6";
export const REPAIR_MAX_CALLS = 786;
const REPAIR_SEED = 2_026_102_205;
export type RepairManifest = {
  schemaVersion: 1;
  develop: RecallEntry;
  replay: RecallEntry;
  repeats: string[];
};
export const REPAIR_SOURCES = [
  "catalogue.ts",
  "index.ts",
  "ui.ts",
  "state.ts",
  "types.ts",
  "display.ts",
  "classifier-request.ts",
  "native-matcher.ts",
  "selection.ts",
  "validation.ts",
  "eval-budget.ts",
  "recall-budget.ts",
  "real-prompt-metrics.ts",
  "eval-metrics.ts",
  "recall-aggregate-calibration.ts",
  "preview-policy.ts",
  "scripts/evaluate.ts",
  "scripts/recall-contract.ts",
  "scripts/recall-scoring.ts",
  "scripts/evaluate-repair.ts",
  "scripts/repair-contract.ts",
  "evals/repair/recognition-core.json",
  "evals/repair/authorization.json",
  "evals/recall/authorization.json",
  "evals/recall/source-manifest.json.txt",
  "evals/recall/development-ledger.json.txt",
] as const;

/** Seeded permutation of the consumed replay IDs; no fresh/heldout sampling. */
export function repairRepeatIds(ids: string[]): string[] {
  let state = REPAIR_SEED;
  const shuffled = [...ids];
  for (let i = shuffled.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const j = state % (i + 1);
    const a = shuffled[i];
    const b = shuffled[j];
    check(a !== undefined && b !== undefined, "Missing replay ID.");
    shuffled[i] = b;
    shuffled[j] = a;
  }
  return shuffled.slice(0, 24);
}
export function sameRepair(a: unknown, b: unknown, message: string) {
  check(stableHash(a) === stableHash(b), message);
}
export function assertRepairLedger(ledger: Ledger, original: Ledger) {
  check(
    original.attempts.length === 1012 && ledger.attempts.length >= 1012,
    "Original 1012 attempts required.",
  );
  sameRepair(ledger.attempts.slice(0, 1012), original.attempts, "Original ledger prefix mutation.");
  check(ledger.otherCostNanos === original.otherCostNanos, "Original ledger cost mutation.");
  check(ledger.attempts.length <= 1798, "Repair call maximum exceeded.");
  check(
    ledger.attempts.slice(1012).every((a) => a.recordId.startsWith("repair/")),
    "Foreign appended attempt.",
  );
}
export async function loadRepairData(path: string, packageRoot: string, ids: string[]) {
  const m = await json<RepairManifest>(path);
  check(m.schemaVersion === 1, "Invalid repair manifest.");
  check(
    m.develop?.records === 612 && m.replay?.records === 150,
    "Exact repair phase counts required.",
  );
  check(m.develop.sha256 === DEVELOPMENT_HASH, "Only consumed calibration permitted.");
  for (const e of [m.develop, m.replay]) {
    check(
      e.kind === "synthetic" && typeof e.file === "string",
      "Public consumed synthetic data only.",
    );
    const allowed =
      e === m.develop
        ? "evals/recall/calibration-consensus.json.txt"
        : "evals/repair/public-replay.json";
    check(
      resolve(dirname(path), e.file) === resolve(packageRoot, allowed),
      "Dataset path must be fixed public consumed data.",
    );
  }
  const develop = await readRecallFixtures(path, [m.develop], ids);
  const replay = await readRecallFixtures(path, [m.replay], ids);
  const pilot = await json<unknown[]>(resolve(packageRoot, "evals/recall/pilot.json"));
  sameRepair(
    replay.map(({ kind: _kind, ...row }) => row),
    pilot.slice(0, 150),
    "Replay must be first 150 consumed pilot rows.",
  );
  sameRepair(m.repeats, repairRepeatIds(replay.map((r) => r.id)), "Repeat precommitment mutation.");
  for (const id of ids) {
    check(
      develop.filter((r) => r.labels[id] === "positive" && !r.named.includes(id)).length >= 10,
      "Development coverage gap.",
    );
  }
  return { m, develop, replay };
}
export async function originalRepairLedger(packageRoot: string): Promise<Ledger> {
  const path = resolve(packageRoot, "evals/recall/development-ledger.json.txt");
  check(
    (await hashFile(path)) === ORIGINAL_LEDGER_HASH,
    "Original STOPPED ledger archive mutation.",
  );
  return json<Ledger>(path);
}

/** External JSON provenance and eligibility must be literal booleans, never truthy values. */
export function assertRepairNative(value: unknown) {
  check(value === true, "Native completion must be literal true.");
}
export function assertRepairReplayFit(value: unknown) {
  check(
    value === true,
    "STOP FURTHER PAID REPLAY: development gates failed or invalid eligibility.",
  );
}
