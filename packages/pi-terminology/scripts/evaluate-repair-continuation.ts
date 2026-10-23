/* oxlint-disable no-await-in-loop -- Native dispatch, ledger transactions and evidence are deliberately serial. */
import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { extractClassifierText } from "../classifier-request";
import type { Ledger, LedgerSession } from "../eval-budget";
import { matchWithNativeClassifier } from "../native-matcher";
import { fitAggregateRecall } from "../recall-aggregate-calibration";
import {
  appendRecallFailure,
  openRecallLedger,
  previewRecallBudget,
  readRecallLedger,
  writeRecallNew,
} from "../recall-budget";
import { selectMatches, suppressAlreadyNamed } from "../selection";
import type { Catalogue, Match } from "../types";
import { stableHash } from "../validation";
import { createNativeRegistry } from "./evaluate";
import type { EvalRegistry, Matcher } from "./evaluate";
import { REPAIR_ROOT } from "./evaluate-repair";
import { check, hashFile } from "./recall-contract";
import type { RecallFixture } from "./recall-contract";
import { dataset } from "./recall-scoring";
import type { RecallObservation } from "./recall-scoring";
import {
  continuationStaticBinding,
  prepareRepairContinuation,
} from "./repair-continuation-contract";
import { sameRepair } from "./repair-contract";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export type ContinuationOptions = {
  manifest: string;
  authorization: string;
  dryRun?: boolean;
  /** Tests must inject BOTH dependencies and an isolated non-default root. */
  runDir?: string;
  matcher?: Matcher;
  createRegistry?: () => Promise<EvalRegistry>;
};
type Prepared = Awaited<ReturnType<typeof prepareRepairContinuation>>;
type Context = {
  o: ContinuationOptions;
  prepared: Prepared;
  directory: string;
  ledger: LedgerSession;
  staticOptions: Parameters<typeof continuationStaticBinding>[0];
  seals: { receiptHash: string; sourceManifestHash: string };
};
function assertBoundary(o: ContinuationOptions) {
  const injected =
    o.runDir !== undefined || o.matcher !== undefined || o.createRegistry !== undefined;
  check(
    !injected ||
      (o.runDir !== undefined &&
        resolve(o.runDir) !== resolve(REPAIR_ROOT) &&
        o.matcher !== undefined &&
        o.createRegistry !== undefined),
    "Tests require BOTH dependencies and an explicit isolated non-default root before any file or registry access.",
  );
  return !injected;
}
function assertProgress(ledger: Ledger, prepared: Prepared, completed: number) {
  check(
    completed >= 0 && completed <= 196 && ledger.attempts.length === 1428 + completed,
    "Unexpected continuation ledger count.",
  );
  sameRepair(
    ledger.attempts.slice(0, 1428),
    prepared.ledger.attempts,
    "Stopped ledger prefix mutation.",
  );
  check(ledger.otherCostNanos === prepared.ledger.otherCostNanos, "Ancillary cost mutation.");
  sameRepair(
    ledger.attempts.slice(1428).map((a) => a.recordId),
    prepared.pending.slice(0, completed).map((row) => `repair/develop-continue/${row.id}/0`),
    "Unexpected continuation ledger IDs.",
  );
  check(
    ledger.attempts
      .slice(1428)
      .every((a) => a.status === "succeeded" && a.reservedNanos === 2_752_512),
    "Failed/unsettled continuation attempt.",
  );
  check(previewRecallBudget(ledger, 196 - completed).fits, "Insufficient continuation budget.");
}
function validateMatches(matches: readonly Match[], catalogue: Catalogue) {
  const ids = new Set(catalogue.recognition.map((r) => r.conceptId));
  check(
    matches.length === 51 &&
      new Set(matches.map((m) => m.concept.id)).size === 51 &&
      matches.every(
        (m) =>
          ids.has(m.concept.id) &&
          Number.isFinite(m.probability) &&
          m.probability >= 0 &&
          m.probability <= 1,
      ),
    "Incomplete probability matrix.",
  );
}
function makeObservation(
  row: RecallFixture,
  matches: readonly Match[],
  catalogue: Catalogue,
  usage: { inputTokens: number | null; outputTokens: number | null },
  start: number,
): RecallObservation {
  const named = suppressAlreadyNamed(extractClassifierText(catalogue, row.prompt), catalogue);
  const empty = {
    hiddenConceptIds: new Set<string>(),
    dismissedConceptIds: new Set<string>(),
    cooldowns: new Map<string, number>(),
  };
  check(
    selectMatches(matches, empty, 0, named).length ===
      matches.filter((m) => !named.has(m.concept.id)).length,
    "Unmodelled runtime drops.",
  );
  return {
    observation: {
      id: row.id,
      split: "tuning",
      repeat: 0,
      alreadyNamed: [...named],
      probabilities: Object.fromEntries(
        matches.map((m) => [m.concept.id, { native: m.probability }]),
      ),
    },
    latencyMs: Math.round(performance.now() - start),
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
}
async function checkStatic(c: Context) {
  sameRepair(
    await readRecallLedger(join(c.staticOptions.runRoot, "ledger.json")),
    c.ledger.snapshot(),
    "On-disk ledger changed under lock.",
  );
  check(
    (await hashFile(join(c.directory, "receipt.json"))) === c.seals.receiptHash,
    "Continuation receipt mutation.",
  );
  check(
    (await hashFile(join(c.directory, "source-manifest.json"))) === c.seals.sourceManifestHash,
    "Continuation source manifest mutation.",
  );
  await verifyArchive(c);
  sameRepair(
    await continuationStaticBinding(c.staticOptions),
    c.prepared.binding,
    "Static continuation inputs changed.",
  );
}
async function collectOne(
  c: Context,
  registry: EvalRegistry,
  row: RecallFixture,
  completed: number,
) {
  await checkStatic(c);
  assertProgress(c.ledger.snapshot(), c.prepared, completed);
  const id = `repair/develop-continue/${row.id}/0`;
  await c.ledger.reserve(id);
  let settled = false;
  const start = performance.now();
  try {
    const result = await (c.o.matcher ?? matchWithNativeClassifier)(
      registry,
      c.prepared.catalogue,
      row.prompt,
      0,
      AbortSignal.timeout(5000),
    );
    check(result.ok, "Native matcher failed; no retry authorized.");
    validateMatches(result.value.matches, c.prepared.catalogue);
    const usage = await c.ledger.settleSuccess(id, result.value.usage);
    settled = true;
    const observation = makeObservation(
      row,
      result.value.matches,
      c.prepared.catalogue,
      usage,
      start,
    );
    await appendRecallFailure(join(c.directory, "observations.jsonl"), observation);
    await appendRecallFailure(join(c.directory, "progress.jsonl"), {
      pid: process.pid,
      completed: completed + 1,
      total: 196,
      lastId: row.id,
      at: new Date().toISOString(),
    });
    return observation;
  } catch (error) {
    if (
      !settled &&
      c.ledger.snapshot().attempts.find((a) => a.recordId === id)?.status === "reserved"
    ) {
      await c.ledger.settleFailure(id);
    }
    await appendRecallFailure(join(c.directory, "failures.jsonl"), {
      id,
      error: "attempt failed; no retry authorized",
    });
    throw error;
  }
}
async function writeSource(path: string, bytes: string) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function archiveSources(c: Context) {
  const sources = [];
  for (const [path, sha256] of Object.entries(c.prepared.binding.continuationSources)) {
    const bytes = await readFile(join(PACKAGE, path), "utf8");
    check(
      createHash("sha256").update(bytes).digest("hex") === sha256,
      "Continuation source changed before archive.",
    );
    const archive = `source/${path}.txt`;
    const destination = join(c.directory, archive);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeSource(destination, bytes);
    sources.push({ path, archive, sha256 });
  }
  await writeRecallNew(join(c.directory, "source-manifest.json"), {
    schemaVersion: 1,
    kind: "append-only-196-development-continuation-sources",
    originalSources: c.prepared.binding.originalSources,
    sources,
  });
}
async function verifyArchive(c: Context) {
  for (const [path, sha256] of Object.entries(c.prepared.binding.continuationSources)) {
    check(
      (await hashFile(join(c.directory, `source/${path}.txt`))) === sha256,
      "Continuation source archive mutation.",
    );
  }
}
async function completeAndFit(c: Context, observations: RecallObservation[], native: boolean) {
  await checkStatic(c);
  await verifyArchive(c);
  assertProgress(c.ledger.snapshot(), c.prepared, 196);
  const persistedBytes = await readFile(join(c.directory, "observations.jsonl"), "utf8");
  const persisted = persistedBytes
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line));
  sameRepair(persisted, observations, "Persisted continuation observations differ.");
  const all = [...c.prepared.previous, ...observations];
  sameRepair(
    all.map((r) => r.observation.id),
    c.prepared.rows.map((r) => r.id),
    "Incomplete combined matrix.",
  );
  check(
    all.length === 612 && new Set(all.map((r) => r.observation.id)).size === 612,
    "Duplicate combined observations.",
  );
  const completion = {
    schemaVersion: 1,
    kind: "combined-development-after-interrupted-original",
    native,
    binding: c.prepared.binding,
    originalInterrupted: true,
    originalCompletionExists: false,
    originalCount: 416,
    continuationCount: 196,
    count: 612,
    receiptHash: await hashFile(join(c.directory, "receipt.json")),
    sourceManifestHash: await hashFile(join(c.directory, "source-manifest.json")),
    continuationObservationsHash: await hashFile(join(c.directory, "observations.jsonl")),
    combinedObservationsHash: stableHash(all),
    orderedIdsHash: stableHash(c.prepared.rows.map((r) => r.id)),
    ledgerHash: await hashFile(join(c.staticOptions.runRoot, "ledger.json")),
  };
  // This NEW combined seal is durable before fitting. The original interrupted phase never gets a completion.
  await writeRecallNew(join(c.directory, "combined.complete.json"), completion);
  const fit = fitAggregateRecall(
    dataset(
      c.prepared.rows,
      all,
      c.prepared.catalogue.concepts.map((x) => x.id),
    ),
  );
  const report = {
    ...fit,
    native,
    measured: false,
    accepted: false,
    metricStatus: "consumed-development-only-combined-continuation",
    stopPaidReplay: !fit.feasible,
    replayAuthorized: false,
    acceptanceExecuted: false,
    previewArtifactAvailable: false,
  };
  await writeRecallNew(join(c.directory, "report.json"), report);
  await writeRecallNew(join(c.directory, "fit-seal.json"), {
    reportHash: await hashFile(join(c.directory, "report.json")),
    completionHash: await hashFile(join(c.directory, "combined.complete.json")),
  });
  return report;
}
async function collect(c: Context, native: boolean) {
  await verifyArchive(c);
  const registry = await (
    c.o.createRegistry ?? (async () => createNativeRegistry(join(homedir(), ".pi/agent")))
  )();
  check(
    registry.getProviderAuthStatus("typesafe").configured,
    "Native TypeSafe authentication unavailable; no attempt reserved.",
  );
  check(
    !native || registry.findOfType("classifier", "typesafe", "jev-latest") !== undefined,
    "Native classifier model unavailable; no attempt reserved.",
  );
  const observations: RecallObservation[] = [];
  for (const row of c.prepared.pending) {
    observations.push(await collectOne(c, registry, row, observations.length));
  }
  return completeAndFit(c, observations, native);
}
async function nativeRootPath() {
  try {
    return await realpath(REPAIR_ROOT);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return resolve(REPAIR_ROOT);
    }
    throw error;
  }
}
export async function runRepairContinuation(o: ContinuationOptions): Promise<unknown> {
  const native = assertBoundary(o);
  const runRoot = resolve(o.runDir ?? REPAIR_ROOT);
  check(
    native || (await realpath(runRoot)) !== (await nativeRootPath()),
    "Injected root cannot alias native root.",
  );
  const staticOptions = {
    packageRoot: PACKAGE,
    runRoot,
    manifest: o.manifest,
    authorization: o.authorization,
  };
  const prepared = await prepareRepairContinuation(staticOptions);
  if (o.dryRun === true) {
    return {
      dryRun: true,
      native: false,
      planned: 196,
      binding: prepared.binding,
      pendingIds: prepared.pending.map((r) => r.id),
      budget: previewRecallBudget(prepared.ledger, 196),
      replayAuthorized: false,
      writes: 0,
      calls: 0,
    };
  }
  const ledger = await openRecallLedger(join(runRoot, "ledger.json"));
  try {
    const locked = await prepareRepairContinuation(staticOptions);
    sameRepair(prepared.binding, locked.binding, "Inputs changed under lock.");
    sameRepair(ledger.snapshot(), locked.ledger, "Ledger changed under lock.");
    const directory = join(runRoot, "repair/continuation");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const c = {
      o,
      prepared: locked,
      directory,
      ledger,
      staticOptions,
      seals: { receiptHash: "", sourceManifestHash: "" },
    };
    await writeRecallNew(join(directory, "receipt.json"), {
      schemaVersion: 1,
      phase: "develop-continue",
      native,
      pid: process.pid,
      burnedAt: new Date().toISOString(),
      binding: locked.binding,
      beforeLedgerHash: await hashFile(join(runRoot, "ledger.json")),
      originalCount: 416,
      additionalCount: 196,
      replayAuthorized: false,
    });
    c.seals.receiptHash = await hashFile(join(directory, "receipt.json"));
    await archiveSources(c);
    c.seals.sourceManifestHash = await hashFile(join(directory, "source-manifest.json"));
    return await collect(c, native);
  } finally {
    await ledger.close();
  }
}
/** A complete but failed development fit remains a non-successful CLI result. */
export function continuationExitCode(result: unknown): 0 | 1 {
  return typeof result === "object" &&
    result !== null &&
    "stopPaidReplay" in result &&
    result.stopPaidReplay === true
    ? 1
    : 0;
}
const main = process.argv[1];
if (main !== undefined && resolve(main) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string" },
      authorization: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  });
  check(
    typeof values.manifest === "string" && typeof values.authorization === "string",
    "Usage: --manifest ORIGINAL_MANIFEST --authorization CONTINUATION_AUTHORIZATION [--dry-run]",
  );
  runRepairContinuation({
    manifest: values.manifest,
    authorization: values.authorization,
    dryRun: values["dry-run"],
  })
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = continuationExitCode(result);
      return undefined;
    })
    .catch(() => {
      process.stderr.write(
        "Continuation refused/failed; receipt and reservations retained; no retry authorized.\n",
      );
      process.exitCode = 1;
    });
}
