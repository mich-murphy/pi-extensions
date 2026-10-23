/* oxlint-disable typescript/no-unnecessary-boolean-literal-compare -- External JSON provenance requires literal booleans. */
/* oxlint-disable no-await-in-loop -- Reservations, dispatch and evidence must be serial and durable. */
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { criteriaHash } from "../catalogue";
import { classifierWireQuestions, extractClassifierText } from "../classifier-request";
import type { LedgerSession } from "../eval-budget";
import { JEV_MODEL_ID, matchWithNativeClassifier } from "../native-matcher";
import { previewBinding } from "../preview-policy";
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
import { check, hashFile, json, loadRecallCatalogue } from "./recall-contract";
import type { RecallFixture } from "./recall-contract";
import { dataset, scoreRecall } from "./recall-scoring";
import type { RecallObservation } from "./recall-scoring";
import {
  assertRepairLedger,
  assertRepairNative,
  assertRepairReplayFit,
  loadRepairData,
  originalRepairLedger,
  ORIGINAL_LEDGER_HASH,
  REPAIR_MAX_CALLS,
  REPAIR_SOURCES,
  sameRepair,
} from "./repair-contract";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPAIR_ROOT = join(homedir(), ".pi/agent/pi-terminology/recall-2026-10-22");
export type RepairOptions = {
  phase: "develop" | "replay" | "freeze-preview";
  manifest: string;
  dryRun?: boolean;
  /** Tests only; both dependencies mandatory, and evidence is permanently non-native. */
  runDir?: string;
  matcher?: Matcher;
  createRegistry?: () => Promise<EvalRegistry>;
};
type Binding = Awaited<ReturnType<typeof repairBinding>>;
type Complete = {
  binding: Binding;
  native: boolean;
  observationsHash: string;
  ledgerHash: string;
  count: number;
};
const file = (root: string, phase: string, suffix: string) =>
  join(root, `repair.${phase}.${suffix}`);
const protocol = {
  model: JEV_MODEL_ID,
  timeoutMs: 5000,
  retries: 0,
  maxNewCalls: REPAIR_MAX_CALLS,
  maxTotalCalls: 1800,
  capNanos: 5_000_000_000,
  threshold: 0,
  maxPrompt: 32_000,
  develop: 612,
  consumedReplay: 150,
  repeats: 24,
  acceptance: "none; consumed public data is not independent acceptance",
};
async function repairBinding(o: RepairOptions, root: string) {
  return {
    manifest: await hashFile(o.manifest),
    authorization: await hashFile(join(root, "authorization.json")),
    originalAuthorization: await hashFile(join(dirname(root), "authorization.json")),
    sources: Object.fromEntries(
      await Promise.all(
        REPAIR_SOURCES.map(async (p) => [p, await hashFile(join(PACKAGE, p))] as const),
      ),
    ),
    datasets: {
      develop: await hashFile(join(PACKAGE, "evals/recall/calibration-consensus.json.txt")),
      replay: await hashFile(join(PACKAGE, "evals/repair/public-replay.json")),
      consumedPilot: await hashFile(join(PACKAGE, "evals/recall/pilot.json")),
    },
    protocol: stableHash(protocol),
  };
}
function assertTestBoundary(o: RepairOptions) {
  const testing =
    o.runDir !== undefined || o.matcher !== undefined || o.createRegistry !== undefined;
  check(
    !testing ||
      (o.runDir !== undefined &&
        resolve(o.runDir) !== resolve(REPAIR_ROOT) &&
        o.matcher !== undefined &&
        o.createRegistry !== undefined),
    "Tests require BOTH injected registry and matcher plus an explicit isolated non-default root before any file or registry access.",
  );
}
async function readCompletion(root: string, phase: string, binding: Binding) {
  const c = await json<Complete>(file(root, phase, "complete.json"));
  sameRepair(c.binding, binding, "Prior phase source binding mutation.");
  assertRepairNative(c.native);
  check(
    c.observationsHash === (await hashFile(file(root, phase, "observations.jsonl"))),
    "Observation mutation.",
  );
  return c;
}
type Context = {
  o: RepairOptions;
  root: string;
  binding: Binding;
  ledger: LedgerSession;
  catalogue: Catalogue;
};
function validateMatrix(matches: readonly Match[], catalogue: Catalogue) {
  check(
    matches.length === 51 &&
      new Set(matches.map((m) => m.concept.id)).size === 51 &&
      matches.every(
        (m) =>
          catalogue.recognition.some((r) => r.conceptId === m.concept.id) &&
          Number.isFinite(m.probability) &&
          m.probability >= 0 &&
          m.probability <= 1,
      ),
    "Incomplete probability matrix.",
  );
}
async function collectOne(c: Context, registry: EvalRegistry, row: RecallFixture, repeat: number) {
  const { o, root, binding, ledger, catalogue } = c;
  sameRepair(await repairBinding(o, root), binding, "Sources changed during collection.");
  const id = `repair/${o.phase}/${row.id}/${repeat}`;
  await ledger.reserve(id);
  let settled = false;
  const start = performance.now();
  try {
    const result = await (o.matcher ?? matchWithNativeClassifier)(
      registry,
      catalogue,
      row.prompt,
      0,
      AbortSignal.timeout(5000),
    );
    check(result.ok, "Native matcher failed.");
    const matches = result.value.matches;
    validateMatrix(matches, catalogue);
    const usage = await ledger.settleSuccess(id, result.value.usage);
    settled = true;
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
    const observation: RecallObservation = {
      observation: {
        id: row.id,
        split: "tuning",
        repeat,
        alreadyNamed: [...named],
        probabilities: Object.fromEntries(
          matches.map((m) => [m.concept.id, { native: m.probability }]),
        ),
      },
      latencyMs: Math.round(performance.now() - start),
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    };
    await appendRecallFailure(file(root, o.phase, "observations.jsonl"), observation);
    return observation;
  } catch (error) {
    if (
      !settled &&
      ledger.snapshot().attempts.find((a) => a.recordId === id)?.status === "reserved"
    ) {
      await ledger.settleFailure(id);
    }
    await appendRecallFailure(file(root, o.phase, "failures.jsonl"), {
      id,
      error: "attempt failed; no retry authorized",
    });
    throw error;
  }
}
async function collectPhase(c: Context, rows: RecallFixture[], repeats: string[]) {
  const registry = await (
    c.o.createRegistry ?? (async () => createNativeRegistry(join(homedir(), ".pi/agent")))
  )();
  const observations: RecallObservation[] = [];
  for (const row of rows) {
    observations.push(await collectOne(c, registry, row, 0));
  }
  for (const id of repeats) {
    const row = rows.find((r) => r.id === id);
    check(row, "Missing repeat row.");
    observations.push(await collectOne(c, registry, row, 1));
  }
  sameRepair(await repairBinding(c.o, c.root), c.binding, "Sources changed during collection.");
  // Collection completion is durable BEFORE fitting. Failed gates never erase native provenance.
  const complete: Complete = {
    binding: c.binding,
    native:
      c.o.runDir === undefined && c.o.matcher === undefined && c.o.createRegistry === undefined,
    observationsHash: await hashFile(file(c.root, c.o.phase, "observations.jsonl")),
    ledgerHash: await hashFile(join(dirname(c.root), "ledger.json")),
    count: observations.length,
  };
  await writeRecallNew(file(c.root, c.o.phase, "complete.json"), complete);
  return observations;
}
async function develop(c: Context, rows: RecallFixture[]) {
  const obs = await collectPhase(c, rows, []);
  const fit = fitAggregateRecall(
    dataset(
      rows,
      obs,
      c.catalogue.concepts.map((x) => x.id),
    ),
  );
  const report = {
    ...fit,
    measured: false,
    accepted: false,
    metricStatus: "consumed-development-only",
    stopPaidReplay: !fit.feasible,
  };
  await writeRecallNew(file(c.root, "develop", "report.json"), report);
  await writeRecallNew(file(c.root, "develop", "fit-seal.json"), {
    reportHash: await hashFile(file(c.root, "develop", "report.json")),
  });
  return report;
}
async function frozenDevelopment(c: Context) {
  check(
    c.o.runDir === undefined && c.o.matcher === undefined && c.o.createRegistry === undefined,
    "Injected evidence cannot produce portable frozen artifacts or replay.",
  );
  const complete = await readCompletion(c.root, "develop", c.binding);
  check(complete.count === 612, "Missing native development observations.");
  const seal = await json<{ reportHash: string }>(file(c.root, "develop", "fit-seal.json"));
  check(
    seal.reportHash === (await hashFile(file(c.root, "develop", "report.json"))),
    "Fit report mutation.",
  );
  const fit = await json<ReturnType<typeof fitAggregateRecall>>(
    file(c.root, "develop", "report.json"),
  );
  check(
    typeof fit.feasible === "boolean" && fit.developmentOnly === true && fit.promotable === false,
    "Invalid fit provenance flags.",
  );
  return { complete, fit };
}
async function replay(c: Context, rows: RecallFixture[], repeats: string[]) {
  const { complete, fit } = await frozenDevelopment(c);
  assertRepairReplayFit(fit.feasible);
  check(
    complete.ledgerHash === (await hashFile(join(dirname(c.root), "ledger.json"))),
    "Development ledger mutation.",
  );
  await writeRecallNew(file(c.root, "replay", "frozen.json"), {
    binding: c.binding,
    thresholds: fit.thresholds,
    questions: classifierWireQuestions(c.catalogue),
    native: true,
    accepted: false,
  });
  const obs = await collectPhase(c, rows, repeats);
  const report = {
    measured: false,
    accepted: false,
    independent: false,
    metricStatus: "consumed-public-replay-not-acceptance",
    metrics: scoreRecall(rows, obs, fit.thresholds),
    repeats: obs.filter((x) => x.observation.repeat === 1),
  };
  await writeRecallNew(file(c.root, "replay", "report.json"), report);
  return report;
}
async function freezePreview(c: Context) {
  const { complete, fit } = await frozenDevelopment(c);
  const count = c.ledger.snapshot().attempts.length;
  check(count === 1624 || count === 1798, "Missing native observations: no preview candidate.");
  if (count === 1624) {
    check(
      complete.ledgerHash === (await hashFile(join(dirname(c.root), "ledger.json"))),
      "Development ledger mutation.",
    );
  }
  if (count === 1798) {
    const replayComplete = await readCompletion(c.root, "replay", c.binding);
    check(
      replayComplete.count === 174 &&
        replayComplete.ledgerHash === (await hashFile(join(dirname(c.root), "ledger.json"))),
      "Incomplete native replay.",
    );
  }
  const policy = {
    schemaVersion: 1,
    ...previewBinding(c.catalogue),
    criteriaHash: criteriaHash(c.catalogue),
    developmentOnly: true,
    measured: false,
    promotable: false,
    acceptanceStatus: "not-validated",
    conceptThresholds: fit.thresholds,
    gaps: ["No independent acceptance: consumed development/replay only.", ...fit.gaps],
    metricStatus: fit.feasible
      ? "UNVALIDATED-development-fit-only"
      : "UNVALIDATED-FAILED-GATES-manual-opt-in-only",
  };
  await writeRecallNew(file(c.root, "freeze-preview", "policy.json"), policy);
  return policy;
}
export async function runRepairEvaluation(o: RepairOptions): Promise<unknown> {
  assertTestBoundary(o);
  check(["develop", "replay", "freeze-preview"].includes(o.phase), "Unknown repair phase.");
  const globalRoot = resolve(o.runDir ?? REPAIR_ROOT);
  const root = join(globalRoot, "repair");
  check(
    resolve(o.manifest).startsWith(`${root}/`),
    "Manifest must be inside fixed repair directory.",
  );
  const catalogue = await loadRecallCatalogue(join(PACKAGE, "evals/repair/recognition-core.json"));
  const data = await loadRepairData(
    o.manifest,
    PACKAGE,
    catalogue.concepts.map((x) => x.id),
  );
  const binding = await repairBinding(o, root);
  check(
    binding.authorization === binding.sources["evals/repair/authorization.json"],
    "Repair authorization bytes differ.",
  );
  check(
    binding.originalAuthorization === binding.sources["evals/recall/authorization.json"],
    "Original authorization bytes differ.",
  );
  const original = await originalRepairLedger(PACKAGE);
  const ledgerPath = join(globalRoot, "ledger.json");
  // Require actual existing shared bytes: readRecallLedger's empty fallback is never authorization.
  const existingLedgerHash = await hashFile(ledgerPath);
  const current = await readRecallLedger(ledgerPath);
  assertRepairLedger(current, original);
  if (current.attempts.length === 1012) {
    check(
      existingLedgerHash === ORIGINAL_LEDGER_HASH,
      "Original STOPPED ledger bytes differ from public snapshot.",
    );
  }
  const planned = { develop: 612, replay: 174, "freeze-preview": 0 }[o.phase];
  check(
    current.attempts.length + planned <= 1798 && previewRecallBudget(current, planned).fits,
    "Insufficient shared budget.",
  );
  if (o.dryRun === true) {
    return {
      dryRun: true,
      planned,
      binding,
      protocol,
      budget: previewRecallBudget(current, planned),
    };
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const ledger = await openRecallLedger(ledgerPath);
  try {
    assertRepairLedger(ledger.snapshot(), original);
    check(previewRecallBudget(ledger.snapshot(), planned).fits, "Budget changed under lock.");
    await writeRecallNew(file(root, o.phase, "receipt.json"), {
      binding,
      phase: o.phase,
      burnedAt: new Date().toISOString(),
    });
    const c = { o, root, binding, ledger, catalogue };
    if (o.phase === "develop") {
      check(
        ledger.snapshot().attempts.length === 1012,
        "Repair development requires exact stopped original prefix.",
      );
      check(
        previewRecallBudget(ledger.snapshot(), REPAIR_MAX_CALLS).fits,
        "Full repair plan must fit shared cap.",
      );
      return await develop(c, data.develop);
    }
    if (o.phase === "replay") {
      return await replay(c, data.replay, data.m.repeats);
    }
    return await freezePreview(c);
  } finally {
    await ledger.close();
  }
}
/** Consumed-development gate failures are non-successful CLI results, not acceptance. */
export function repairExitCode(result: unknown): 0 | 1 {
  return typeof result === "object" &&
    result !== null &&
    "stopPaidReplay" in result &&
    result.stopPaidReplay === true
    ? 1
    : 0;
}
const main = process.argv[1];
if (typeof main === "string" && resolve(main) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      phase: { type: "string" },
      manifest: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  });
  check(
    (values.phase === "develop" ||
      values.phase === "replay" ||
      values.phase === "freeze-preview") &&
      typeof values.manifest === "string",
    "Usage: --phase develop|replay|freeze-preview --manifest PATH [--dry-run]",
  );
  runRepairEvaluation({ phase: values.phase, manifest: values.manifest, dryRun: values["dry-run"] })
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = repairExitCode(result);
      return undefined;
    })
    .catch(() => {
      process.stderr.write(
        "Repair refused/failed; no retry/resume authorized. Inspect private artifacts.\n",
      );
      process.exitCode = 1;
    });
}
