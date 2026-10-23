/* oxlint-disable no-await-in-loop -- Validate immutable evidence in a deterministic order before any dispatch. */
import { readFileSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { extractClassifierText } from "../classifier-request";
import { previewRecallBudget, readRecallLedger } from "../recall-budget";
import { suppressAlreadyNamed } from "../selection";
import { diagnoseRepairRecovery } from "./diagnose-repair-recovery";
import { check, hashFile, json, loadRecallCatalogue, readRecallFixtures } from "./recall-contract";
import type { RecallEntry } from "./recall-contract";
import type { RecallObservation } from "./recall-scoring";
import { sameRepair } from "./repair-contract";

export type ContinuationContractOptions = {
  packageRoot: string;
  runRoot: string;
  manifest: string;
  authorization: string;
};
const PUBLIC = "evals/repair/";
const DATASET = "evals/recall/calibration-consensus.json.txt";
const RESULT_HASH = "9c67376ef30102398b3954aa111c76dcb352ca6160c61c4f7b2880a3dde6f65f";
const NEW_SOURCES = [
  "scripts/evaluate-repair-continuation.ts",
  "scripts/repair-continuation-contract.ts",
  "scripts/diagnose-repair-recovery.ts",
  "evals/repair/continuation/authorization.json",
];
async function absent(path: string) {
  try {
    await lstat(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error("Existing completion, failure or burned continuation receipt forbids retry.");
}
async function fixedPaths(o: ContinuationContractOptions) {
  const root = await realpath(o.runRoot);
  const expected = [
    join(root, "repair/manifest.json"),
    join(root, "repair/continuation/authorization.json"),
  ];
  for (const [index, path] of [o.manifest, o.authorization].entries()) {
    check(
      resolve(path) ===
        join(
          resolve(o.runRoot),
          index === 0 ? "repair/manifest.json" : "repair/continuation/authorization.json",
        ),
      "Manifest and continuation authorization must use their fixed paths.",
    );
    check(
      (await realpath(path)) === expected[index],
      "Symlink substitution of continuation inputs.",
    );
  }
}
async function authorization(o: ContinuationContractOptions) {
  const publicPath = join(o.packageRoot, PUBLIC, "continuation/authorization.json");
  const auth = await json<Record<string, unknown>>(publicPath);
  check(
    auth.schemaVersion === 1 &&
      auth.status === "approved-196-unattempted-development-only-append-only-continuation" &&
      auth.userApproval === "yes" &&
      auth.additionalAttempts === 196 &&
      auth.existingAttempts === 1428 &&
      auth.maximumResultingAttempts === 1624 &&
      auth.additionalReservationNanos === 539_492_352 &&
      auth.maximumResultingReservationsNanos === 4_470_079_488 &&
      auth.sharedCapNanos === 5_000_000_000 &&
      auth.sharedMaximumAttempts === 1800 &&
      auth.model === "jev-1.13.0" &&
      auth.timeoutMs === 5000 &&
      auth.automaticRetries === 0,
    "Invalid bounded continuation authorization.",
  );
  for (const key of [
    "consumedReplayAuthorized",
    "repeatCallsAuthorized",
    "freshAcceptanceAuthorized",
    "privatePromptDispatchAuthorized",
    "productionPromotionAuthorized",
    "runtimeActivationAuthorized",
    "retryOrSecondContinuationAuthorized",
  ]) {
    check(
      auth[key] === false,
      "Continuation must not authorize replay, acceptance, activation or retry.",
    );
  }
  check(
    (await hashFile(o.authorization)) === (await hashFile(publicPath)),
    "Continuation authorization bytes differ.",
  );
  for (const [key, path] of [
    ["developmentSourceSha256", DATASET],
    ["originalReceiptSha256", `${PUBLIC}development-receipt.json.txt`],
    ["originalObservationsSha256", `${PUBLIC}development-observations.jsonl`],
    ["stoppedLedgerSha256", `${PUBLIC}development-ledger.json.txt`],
  ] as const) {
    check(
      auth[key] === (await hashFile(join(o.packageRoot, path))),
      "Approval-to-evidence hash mismatch.",
    );
  }
}
async function historicalInputs(o: ContinuationContractOptions) {
  const receipt = await json<{ binding: { sources: Record<string, string> } }>(
    join(o.packageRoot, PUBLIC, "development-receipt.json.txt"),
  );
  const pairs = [
    [
      join(o.runRoot, "repair/manifest.json"),
      join(o.packageRoot, PUBLIC, "operator-manifest.json.txt"),
    ],
    [join(o.runRoot, "authorization.json"), join(o.packageRoot, "evals/recall/authorization.json")],
    [
      join(o.runRoot, "repair/authorization.json"),
      join(o.packageRoot, PUBLIC, "authorization.json"),
    ],
    [
      join(o.runRoot, "repair/repair.develop.receipt.json"),
      join(o.packageRoot, PUBLIC, "development-receipt.json.txt"),
    ],
    [
      join(o.runRoot, "repair/repair.develop.observations.jsonl"),
      join(o.packageRoot, PUBLIC, "development-observations.jsonl"),
    ],
  ];
  const hashes: string[] = [];
  for (const pair of pairs) {
    const [live, archived] = pair;
    check(live !== undefined && archived !== undefined, "Missing historical binding path.");
    const digest = await hashFile(live);
    check(
      digest === (await hashFile(archived)),
      "Historical manifest, authorization, receipt or observations mutation.",
    );
    hashes.push(digest);
  }
  const stopped = await json<{ status: string; calls: { total: number; repairSucceeded: number } }>(
    join(o.runRoot, "repair/STOPPED.json"),
  );
  check(
    stopped.status === "development-interrupted-operator-timeout" &&
      stopped.calls.total === 1428 &&
      stopped.calls.repairSucceeded === 416,
    "Missing honest original interruption marker.",
  );
  return {
    originalSources: receipt.binding.sources,
    historicalHashes: hashes,
    stoppedMarkerHash: await hashFile(join(o.runRoot, "repair/STOPPED.json")),
  };
}
/** No ledger hash here: the immutable receipt is checked again before EACH new reservation. */
export async function continuationStaticBinding(o: ContinuationContractOptions) {
  await fixedPaths(o);
  check(
    (await hashFile(join(o.packageRoot, PUBLIC, "result.json"))) === RESULT_HASH,
    "Stopped-result trust root mutation.",
  );
  const diagnostic = diagnoseRepairRecovery((path) =>
    readFileSync(join(o.packageRoot, path), "utf8"),
  );
  check(diagnostic.sourceDrift.length === 0, "Original frozen source drift.");
  await authorization(o);
  const historical = await historicalInputs(o);
  for (const name of [
    "repair.develop.complete.json",
    "repair.develop.report.json",
    "repair.develop.fit-seal.json",
    "repair.develop.failures.jsonl",
    "repair.replay.receipt.json",
    "repair.freeze-preview.receipt.json",
  ]) {
    await absent(join(o.runRoot, "repair", name));
  }
  const continuationSources = Object.fromEntries(
    await Promise.all(
      NEW_SOURCES.map(async (path) => [path, await hashFile(join(o.packageRoot, path))] as const),
    ),
  );
  return {
    schemaVersion: 1,
    ...historical,
    continuationSources,
    originalReceiptHash: await hashFile(
      join(o.packageRoot, PUBLIC, "development-receipt.json.txt"),
    ),
    originalObservationsHash: await hashFile(
      join(o.packageRoot, PUBLIC, "development-observations.jsonl"),
    ),
    originalSourceManifestHash: await hashFile(
      join(o.packageRoot, PUBLIC, "source-manifest.json.txt"),
    ),
    datasetHash: await hashFile(join(o.packageRoot, DATASET)),
    continuationAuthorizationHash: await hashFile(o.authorization),
    protocol: {
      model: "jev-1.13.0",
      additionalCalls: 196,
      timeoutMs: 5000,
      retries: 0,
      threshold: 0,
      totalCalls: 1624,
      reservationNanos: 4_470_079_488,
      replayAuthorized: false,
    },
  };
}
const observationLine = (line: string) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Bytes match the independently checked public 416-by-51 prefix before parsing.
  JSON.parse(line) as RecallObservation;
async function pendingData(o: ContinuationContractOptions) {
  const catalogue = await loadRecallCatalogue(join(o.packageRoot, PUBLIC, "recognition-core.json"));
  const manifest = await json<{ develop: RecallEntry }>(o.manifest);
  const rows = await readRecallFixtures(
    o.manifest,
    [{ ...manifest.develop, file: join(o.packageRoot, DATASET) }],
    catalogue.concepts.map((c) => c.id),
  );
  check(
    rows.length === 612 && rows.every((r) => r.kind === "synthetic"),
    "Exact public development matrix required.",
  );
  const previousBytes = await readFile(
    join(o.runRoot, "repair/repair.develop.observations.jsonl"),
    "utf8",
  );
  const previous = previousBytes
    .trim()
    .split("\n")
    .map((line) => observationLine(line));
  sameRepair(
    previous.map((r) => r.observation.id),
    rows.slice(0, 416).map((r) => r.id),
    "Historical observation prefix mismatch.",
  );
  for (const [index, row] of rows.slice(0, 416).entries()) {
    sameRepair(
      previous[index]?.observation.alreadyNamed,
      [...suppressAlreadyNamed(extractClassifierText(catalogue, row.prompt), catalogue)],
      "Historical already-named suppression mismatch.",
    );
  }
  const pending = rows.slice(416);
  check(previous.length === 416 && pending.length === 196, "Exact 416-plus-196 matrix required.");
  return { catalogue, rows, previous, pending };
}
export async function prepareRepairContinuation(o: ContinuationContractOptions) {
  const binding = await continuationStaticBinding(o);
  for (const name of [
    "receipt.json",
    "observations.jsonl",
    "failures.jsonl",
    "combined.complete.json",
    "report.json",
    "fit-seal.json",
    "source-manifest.json",
  ]) {
    await absent(join(o.runRoot, "repair/continuation", name));
  }
  check(
    (await hashFile(join(o.runRoot, "ledger.json"))) ===
      (await hashFile(join(o.packageRoot, PUBLIC, "development-ledger.json.txt"))),
    "Stopped live ledger mutation.",
  );
  const ledger = await readRecallLedger(join(o.runRoot, "ledger.json"));
  check(
    ledger.attempts.length === 1428 && previewRecallBudget(ledger, 196).fits,
    "Invalid existing cumulative budget.",
  );
  const data = await pendingData(o);
  return { binding, ledger, ...data };
}
