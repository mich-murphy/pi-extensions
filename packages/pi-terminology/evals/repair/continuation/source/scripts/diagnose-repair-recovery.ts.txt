import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ledger } from "../eval-budget";

const PACKAGE = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const BASE = "evals/repair/";
const RESERVATION = 2_752_512;
const DATASET = "evals/recall/calibration-consensus.json.txt";
const ORIGINAL = "evals/recall/development-ledger.json.txt";
const STOPPED_RESULT_SHA256 = "9c67376ef30102398b3954aa111c76dcb352ca6160c61c4f7b2880a3dde6f65f";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
type Reader = (path: string) => string;
function check(value: boolean, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Typed deserialization boundary; diagnostic fields are validated below.
const parse = <T>(text: string) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Hash-bound public JSON is checked before its diagnostic fields are used.
  JSON.parse(text) as T;
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Preserve the deserialized boundary type through the injected reader.
const json = <T>(read: Reader, path: string) => parse<T>(read(path));
function readPublic(path: string): string {
  check(
    !/(?:private|heldout|acceptance)/iu.test(path),
    "No private or acceptance reads permitted.",
  );
  const absolute = realpathSync(resolve(PACKAGE, path));
  check(absolute.startsWith(`${PACKAGE}${sep}`), "Only checkout-local public files permitted.");
  const text = readFileSync(absolute, "utf8");
  if (path === `${BASE}result.json`) {
    check(hash(text) === STOPPED_RESULT_SHA256, "Stopped result trust-root mutation.");
  }
  return text;
}
function same(a: unknown, b: unknown, message: string) {
  check(JSON.stringify(a) === JSON.stringify(b), message);
}
type Result = {
  status: string;
  calls: { repairSucceeded: number; total: number; unattemptedDevelopment: number };
  budget: { totalReservedNanos: number; capNanos: number };
  sourceManifestSha256: string;
  artifacts: Record<string, string>;
};
type Receipt = {
  phase: string;
  binding: { manifest: string; sources: Record<string, string>; datasets: { develop: string } };
};
type Observation = {
  observation: {
    id: string;
    split: string;
    repeat: number;
    probabilities: Record<string, { native: number }>;
  };
};
function verifyArtifacts(read: Reader) {
  const result = json<Result>(read, `${BASE}result.json`);
  check(
    result.status === "development-interrupted-operator-timeout",
    "Not the interrupted repair.",
  );
  check(
    result.calls.repairSucceeded === 416 &&
      result.calls.total === 1428 &&
      result.calls.unattemptedDevelopment === 196,
    "Unexpected stopped-run counts.",
  );
  const names = [
    "compiled-profile.json.txt",
    "development-ledger.json.txt",
    "development-observations.jsonl",
    "development-receipt.json.txt",
    "operator-manifest.json.txt",
    "preflight.json.txt",
  ];
  same(Object.keys(result.artifacts).toSorted(), names, "Unexpected artifact set.");
  for (const name of names) {
    check(hash(read(`${BASE}${name}`)) === result.artifacts[name], `Artifact mutation: ${name}`);
  }
  check(
    hash(read(`${BASE}source-manifest.json.txt`)) === result.sourceManifestSha256,
    "Source manifest mutation.",
  );
  return result;
}
function verifySources(read: Reader) {
  const manifest = json<{ sources: { path: string; archive: string; sha256: string }[] }>(
    read,
    `${BASE}source-manifest.json.txt`,
  );
  const receipt = json<Receipt>(read, `${BASE}development-receipt.json.txt`);
  check(receipt.phase === "develop", "Wrong original phase.");
  check(
    hash(read(`${BASE}operator-manifest.json.txt`)) === receipt.binding.manifest,
    "Operator manifest/receipt mismatch.",
  );
  check(manifest.sources.length === 26, "Expected 26 frozen sources.");
  same(
    manifest.sources.map((source) => source.path).toSorted(),
    Object.keys(receipt.binding.sources).toSorted(),
    "Source/receipt key mismatch.",
  );
  check(new Set(manifest.sources.map((source) => source.path)).size === 26, "Duplicate source.");
  const sourceDrift: string[] = [];
  for (const source of manifest.sources) {
    check(source.sha256 === receipt.binding.sources[source.path], "Source/receipt hash mismatch.");
    check(
      hash(read(`${BASE}${source.archive}`)) === source.sha256,
      `Archive mutation: ${source.path}`,
    );
    try {
      if (hash(read(source.path)) !== source.sha256) {
        sourceDrift.push(source.path);
      }
    } catch {
      sourceDrift.push(source.path);
    }
  }
  check(hash(read(DATASET)) === receipt.binding.datasets.develop, "Fixed dataset mutation.");
  check(hash(read(ORIGINAL)) === receipt.binding.sources[ORIGINAL], "Original ledger mutation.");
  return { sourceDrift, sourceCount: manifest.sources.length };
}
function verifyObservations(read: Reader) {
  const rows = json<{ id: string }[]>(read, DATASET);
  const ids = rows.map((row) => row.id);
  check(
    ids.length === 612 && new Set(ids).size === 612 && ids.every((id) => typeof id === "string"),
    "Invalid fixed development IDs.",
  );
  const observations = read(`${BASE}development-observations.jsonl`)
    .trim()
    .split("\n")
    .map((line) => parse<Observation>(line));
  check(observations.length === 416, "Incomplete preserved observation prefix.");
  same(
    observations.map((row) => row.observation.id),
    ids.slice(0, 416),
    "Observation order mutation.",
  );
  const profile = json<{ questions: Record<string, unknown> }>(
    read,
    `${BASE}compiled-profile.json.txt`,
  );
  const concepts = Object.keys(profile.questions).toSorted();
  check(concepts.length === 51, "Expected 51 questions.");
  for (const { observation } of observations) {
    check(
      observation.split === "tuning" && observation.repeat === 0,
      "Wrong observation provenance.",
    );
    same(
      Object.keys(observation.probabilities).toSorted(),
      concepts,
      "Incomplete probability matrix.",
    );
    check(
      Object.values(observation.probabilities).every(
        ({ native }) =>
          typeof native === "number" && Number.isFinite(native) && native >= 0 && native <= 1,
      ),
      "Invalid probability.",
    );
  }
  return ids;
}
function verifyLedger(read: Reader, ids: string[], result: Result) {
  const original = json<Ledger>(read, ORIGINAL);
  const ledger = json<Ledger>(read, `${BASE}development-ledger.json.txt`);
  check(original.schemaVersion === 1 && ledger.schemaVersion === 1, "Invalid ledger schema.");
  check(
    original.attempts.length === 1012 && ledger.attempts.length === 1428,
    "Wrong ledger counts.",
  );
  same(ledger.attempts.slice(0, 1012), original.attempts, "Original ledger prefix mutation.");
  check(
    ledger.otherCostNanos === original.otherCostNanos && ledger.otherCostNanos === 0,
    "Unexpected ancillary cost.",
  );
  check(
    new Set(ledger.attempts.map((attempt) => attempt.recordId)).size === 1428,
    "Duplicate attempt.",
  );
  check(
    ledger.attempts.every(
      (attempt) => attempt.status === "succeeded" && attempt.reservedNanos === RESERVATION,
    ),
    "Unsettled/failed attempt or wrong reservation.",
  );
  same(
    ledger.attempts.slice(1012).map((attempt) => attempt.recordId),
    ids.slice(0, 416).map((id) => `repair/develop/${id}/0`),
    "Repair ledger/observation mismatch.",
  );
  const reservedNanos = ledger.attempts.reduce((sum, attempt) => sum + attempt.reservedNanos, 0);
  check(
    reservedNanos === result.budget.totalReservedNanos && reservedNanos === 3_930_587_136,
    "Reservation total mismatch.",
  );
  check(result.budget.capNanos === 5_000_000_000, "Shared cap mutation.");
  return reservedNanos;
}

/** Read-only public-snapshot diagnostic. An injected reader supplies trusted test fixtures, not dispatch authority. */
export function diagnoseRepairRecovery(read: (path: string) => string = readPublic) {
  const result = verifyArtifacts(read);
  const sources = verifySources(read);
  const ids = verifyObservations(read);
  const reservedNanos = verifyLedger(read, ids, result);
  const pendingIds = ids.slice(416);
  const project = (calls: number) => ({
    additionalCalls: calls,
    additionalReservedNanos: calls * RESERVATION,
    totalCalls: result.calls.total + calls,
    totalReservedNanos: reservedNanos + calls * RESERVATION,
  });
  const development = project(pendingIds.length);
  const conditionalReplay = project(pendingIds.length + 174);
  check(
    conditionalReplay.totalCalls <= 1800 &&
      conditionalReplay.totalReservedNanos <= result.budget.capNanos,
    "Insufficient shared budget.",
  );
  return {
    status:
      sources.sourceDrift.length === 0 ? "public-evidence-consistent" : "blocked-source-drift",
    authorized: false,
    nativeCalls: 0,
    privateLedgerChecked: false,
    continuationImplemented: false,
    ...sources,
    preservedObservations: 416,
    pendingIds,
    development,
    conditionalReplay,
    blockers: [
      "Explicit approval and an independently reviewed append-only continuation runner required.",
      "Live ledger, locks and process ownership must be checked separately before dispatch.",
      ...(sources.sourceDrift.length
        ? ["Current frozen sources differ from the interrupted receipt."]
        : []),
    ],
  };
}
const main = process.argv[1];
if (main !== undefined && resolve(main) === fileURLToPath(import.meta.url)) {
  try {
    check(process.argv.length === 2, "Usage: diagnose-repair-recovery.ts (no arguments)");
    const result = diagnoseRepairRecovery();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.sourceDrift.length ? 1 : 0;
  } catch {
    process.stderr.write(
      "Recovery diagnostic refused inconsistent or unreadable public evidence.\n",
    );
    process.exitCode = 1;
  }
}
