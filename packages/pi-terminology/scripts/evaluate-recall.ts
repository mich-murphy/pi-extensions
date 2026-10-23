/* oxlint-disable typescript/no-non-null-assertion -- Validated complete probability matrices and fixed test fixtures make mandatory indexed lookups safe. */
/* oxlint-disable no-await-in-loop -- Serial durable reservations and fail-fast phases are intentional. */
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { extractClassifierText, classifierWireQuestions } from "../classifier-request";
import type { LedgerSession } from "../eval-budget";
import { matchWithNativeClassifier, JEV_MODEL_ID } from "../native-matcher";
import {
  openRecallLedger,
  syncRecallEvidence,
  appendRecallFailure,
  previewRecallBudget,
  readRecallLedger,
  writeRecallNew,
  RECALL_PLANNED_ATTEMPTS,
} from "../recall-budget";
import { tuneRecall } from "../recall-calibration";
import { selectMatches, suppressAlreadyNamed } from "../selection";
import type { Catalogue } from "../types";
import { stableHash } from "../validation";
import { createNativeRegistry } from "./evaluate";
import type { EvalRegistry, Matcher } from "./evaluate";
import {
  check,
  hashFile,
  json,
  loadRecallCatalogue,
  loadRecallManifest,
  normalizedPromptHash,
  readRecallFixtures,
  readOldTenCutoffs,
  validateRecallSeal,
} from "./recall-contract";
import type { RecallFixture, RecallManifest } from "./recall-contract";
import {
  acceptance,
  assertDevelopment,
  dataset,
  rankPilot,
  scoreRecall,
  verificationReport,
} from "./recall-scoring";
import type { RecallObservation } from "./recall-scoring";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECALL_RUN = join(homedir(), ".pi/agent/pi-terminology/recall-2026-10-22");
const PROFILE_FILES = {
  baseline: "evals/recall/baseline-core.json",
  semanticRepair: "evals/recall/semantic-repair-core.json",
} as const;
type Profile = keyof typeof PROFILE_FILES;
const RECALL_SOURCE_FILES = [
  "catalogue.ts",
  "index.ts",
  "ui.ts",
  "state.ts",
  "types.ts",
  "eval-metrics.ts",
  "classifier-request.ts",
  "native-matcher.ts",
  "selection.ts",
  "real-prompt-metrics.ts",
  "validation.ts",
  "eval-budget.ts",
  "scripts/evaluate.ts",
  "scripts/evaluate-expansion.ts",
  "scripts/verify-production.ts",
  "glossary/core.json",
  "glossary/policy.json",
  "evals/production/core.json",
  "evals/production/policy.json",
  "recall-budget.ts",
  "recall-calibration.ts",
  "scripts/evaluate-recall.ts",
  "scripts/recall-contract.ts",
  "scripts/recall-scoring.ts",
  "evals/recall/authorization.json",
  "evals/recall/pilot-provenance.json",
  ...Object.values(PROFILE_FILES),
];
export type RecallEvaluationOptions = {
  phase: "pilot" | "calibrate" | "freeze" | "verify";
  manifest: string;
  dryRun?: boolean;
  /** Test-only boundaries; injected evidence is permanently marked non-native and cannot be frozen or accepted. */
  runDir?: string;
  createRegistry?: () => Promise<EvalRegistry>;
  matcher?: Matcher;
};
type Binding = {
  manifest: string;
  seal: string;
  authorization: string;
  sources: Record<string, string>;
  protocol: string;
};
type Completion = {
  binding: Binding;
  native: boolean;
  ledgerHash: string;
  reportHash: string;
  observationsHash: string;
};
type PilotReport = {
  selected: Profile;
  ranking: Record<Profile, ReturnType<typeof rankPilot>>;
  questionSemantics: Record<Profile, unknown>;
};
type CalibrationReport = {
  profile: Profile;
  thresholds: Record<string, number>;
  gaps: string[];
  metrics: ReturnType<typeof scoreRecall>;
};
type Frozen = {
  binding: Binding;
  profile: Profile;
  thresholds: Record<string, number>;
  questions: unknown;
  extraction: string;
  suppression: string;
  pilot: Completion;
  calibration: Completion;
  ledgerHash: string;
  native: true;
};
const EMPTY = {
  hiddenConceptIds: new Set<string>(),
  dismissedConceptIds: new Set<string>(),
  cooldowns: new Map<string, number>(),
};
const protocol = {
  model: JEV_MODEL_ID,
  timeoutMs: 5000,
  retries: 0,
  planned: 1786,
  capNanos: 5_000_000_000,
  maxAttempts: 1800,
  grid: [0.8, 0.99, 0.01],
  pilotRanking:
    "5-fold sorted-ID round-robin; maximize heldout-within-pilot recall subject pooled scored precision>=.90; ties lower FP then baseline; no per-concept cherry picking",
  pilotMinCoverage: 3,
  calibrationMinimum: 10,
  display:
    "Primary gates score renderReminder first3 eligible canonical localeCompare concept IDs; +N more is not a visible name; raw candidate-selected scores are secondary diagnostics; old10 baseline gets its own first3 slots.",
  acceptance:
    "precision>=.90 overall/private/synthetic; recall>=.85 overall/private; synthetic each recall>=.70 and positives>=10; private positive prompts>=20; useful private gain>0 vs archived old10",
};
async function bindingAt(o: RecallEvaluationOptions, m: RecallManifest): Promise<Binding> {
  return {
    manifest: await hashFile(o.manifest),
    seal: await hashFile(resolve(dirname(o.manifest), m.seal.file)),
    authorization: await hashFile(join(o.runDir ?? RECALL_RUN, "authorization.json")),
    sources: Object.fromEntries(
      await Promise.all(
        RECALL_SOURCE_FILES.map(async (f) => [f, await hashFile(join(PACKAGE, f))] as const),
      ),
    ),
    protocol: stableHash(protocol),
  };
}
function isNative(value: unknown): value is true {
  return value === true;
}
function same(a: unknown, b: unknown, message: string) {
  check(stableHash(a) === stableHash(b), message);
}
async function assertBinding(o: RecallEvaluationOptions, m: RecallManifest, binding: Binding) {
  same(await bindingAt(o, m), binding, "Source/profile/manifest/seal mutation detected.");
}
const artifact = (root: string, phase: string, suffix: string) => join(root, `${phase}.${suffix}`);
async function completion(root: string, phase: string, binding: Binding): Promise<Completion> {
  const c = await json<Completion>(artifact(root, phase, "complete.json"));
  check(typeof c.native === "boolean", "Completion native provenance must be a boolean.");
  same(c.binding, binding, "Prior phase binding mutation.");
  check(
    c.reportHash === (await hashFile(artifact(root, phase, "report.json"))) &&
      c.observationsHash === (await hashFile(artifact(root, phase, "observations.jsonl"))),
    "Prior evidence mutation.",
  );
  return c;
}
async function collect(
  o: RecallEvaluationOptions,
  root: string,
  m: RecallManifest,
  binding: Binding,
  ledger: LedgerSession,
  registry: EvalRegistry,
  catalogue: Catalogue,
  rows: RecallFixture[],
  profile: string,
  repeats: string[] = [],
) {
  const observations: RecallObservation[] = [];
  for (const [row, repeat] of [
    ...rows.map((r) => [r, 0] as const),
    ...repeats.map((id) => {
      const r = rows.find((f) => f.id === id);
      check(r, "Unknown precommitted repeat ID.");
      return [r, 1] as const;
    }),
  ]) {
    await assertBinding(o, m, binding);
    const id = `${o.phase}/${profile}/${row.id}/${repeat}`;
    await ledger.reserve(id);
    const start = performance.now();
    let settled = false;
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
      check(
        matches.length === 51 &&
          new Set(matches.map((x) => x.concept.id)).size === 51 &&
          matches.every(
            (x) =>
              catalogue.recognition.some((r) => r.conceptId === x.concept.id) &&
              Number.isFinite(x.probability) &&
              x.probability >= 0 &&
              x.probability <= 1,
          ),
        "Incomplete native probability matrix.",
      );
      settled = true;
      const usage = await ledger.settleSuccess(id, result.value.usage);
      const alreadyNamed = suppressAlreadyNamed(
        extractClassifierText(catalogue, row.prompt),
        catalogue,
      );
      check(
        selectMatches(matches, EMPTY, 0, alreadyNamed).length ===
          matches.filter((x) => !alreadyNamed.has(x.concept.id)).length,
        "Unmodelled runtime selector drops.",
      );
      const observation: RecallObservation = {
        observation: {
          id: row.id,
          split: o.phase === "verify" ? "heldout" : "tuning",
          repeat,
          alreadyNamed: [...alreadyNamed],
          probabilities: Object.fromEntries(
            matches.map((x) => [x.concept.id, { native: x.probability }]),
          ),
        },
        latencyMs: Math.round(performance.now() - start),
        inputTokens: usage.inputTokens!,
        outputTokens: usage.outputTokens!,
      };
      await appendFile(
        artifact(root, o.phase, "observations.jsonl"),
        `${JSON.stringify({ ...observation, profile })}\n`,
        { mode: 0o600 },
      );
      observations.push(observation);
    } catch {
      if (!settled) {
        await ledger.settleFailure(id);
      }
      await appendRecallFailure(artifact(root, o.phase, "failures.jsonl"), {
        id,
        latencyMs: Math.round(performance.now() - start),
        inputTokens: null,
        outputTokens: null,
      });
      throw new Error(
        "Recall attempt failed; reservation retained, phase burned, no retry/resume permitted.",
      );
    }
  }
  return observations;
}
type PhaseContext = {
  o: RecallEvaluationOptions;
  root: string;
  m: RecallManifest;
  binding: Binding;
  ledger: LedgerSession;
  ledgerPath: string;
  profiles: Record<Profile, Catalogue>;
  ids: string[];
};
async function pilotPhase(context: PhaseContext) {
  const { o, root, m, binding, ledger, profiles, ids } = context;
  check(
    ledger.snapshot().attempts.length === 0,
    "Pilot requires a fresh recall authorization ledger.",
  );
  check(
    previewRecallBudget(ledger.snapshot(), RECALL_PLANNED_ATTEMPTS).fits,
    "Full planned experiment does not fit authorization.",
  );
  const rows = await readRecallFixtures(o.manifest, m.pilot, ids);
  for (const id of ids) {
    check(
      rows.filter((r) => r.labels[id] === "positive" && !r.named.includes(id)).length >= 3,
      "Pilot positive coverage gap.",
    );
  }
  const registry = await (
    o.createRegistry ?? (async () => createNativeRegistry(join(homedir(), ".pi/agent")))
  )();
  const rank = async (profile: Profile) =>
    rankPilot(
      rows,
      await collect(o, root, m, binding, ledger, registry, profiles[profile], rows, profile),
      ids,
    );
  const ranking = {
    baseline: await rank("baseline"),
    semanticRepair: await rank("semanticRepair"),
  };
  const candidates = (["baseline", "semanticRepair"] as const)
    .filter((p) => ranking[p].eligible)
    .toSorted(
      (a, b) =>
        ranking[b].recall - ranking[a].recall ||
        ranking[a].fp - ranking[b].fp ||
        (a === "baseline" ? -1 : 1),
    );
  const report = {
    selected: candidates[0] ?? null,
    ranking,
    questionSemantics: Object.fromEntries(
      Object.entries(profiles).map(([p, c]) => [p, classifierWireQuestions(c)]),
    ),
  };
  await writeRecallNew(artifact(root, "pilot", "report.json"), report);
  check(
    candidates.length > 0,
    "Neither whole profile achieves pilot scored precision .90; diagnostic report retained.",
  );

  return report;
}
async function calibrationPhase(
  context: PhaseContext,
  pilot: Completion,
  pilotReport: PilotReport,
  catalogue: Catalogue,
) {
  const { o, root, m, binding, ledger, ledgerPath, ids } = context;
  check(
    pilot.ledgerHash === (await hashFile(ledgerPath)) && ledger.snapshot().attempts.length === 400,
    "Pilot ledger mutated or phase ordering violated.",
  );
  const rows = await readRecallFixtures(o.manifest, m.calibration, ids);
  const pilotRows = await readRecallFixtures(o.manifest, m.pilot, ids);
  const consumed = new Set(pilotRows.map((r) => normalizedPromptHash(r.prompt)));
  check(
    rows.every(
      (r) => !consumed.has(normalizedPromptHash(r.prompt)) && !pilotRows.some((p) => p.id === r.id),
    ),
    "Calibration overlaps consumed pilot.",
  );
  for (const id of ids) {
    check(
      rows.filter((r) => r.labels[id] === "positive" && !r.named.includes(id)).length >= 10,
      "Calibration positive coverage gap.",
    );
  }
  const registry = await (
    o.createRegistry ?? (async () => createNativeRegistry(join(homedir(), ".pi/agent")))
  )();
  const obs = await collect(
    o,
    root,
    m,
    binding,
    ledger,
    registry,
    catalogue,
    rows,
    pilotReport.selected,
  );
  const tuned = tuneRecall(dataset(rows, obs, ids));
  const metrics = scoreRecall(rows, obs, tuned.thresholds);
  // Preserve diagnostics even when calibration cannot advance.
  const report = {
    profile: pilotReport.selected,
    thresholds: tuned.thresholds,
    gaps: tuned.gaps,
    metrics,
  };
  await writeRecallNew(artifact(root, o.phase, "report.json"), report);
  assertDevelopment(metrics, tuned.thresholds, tuned.gaps);

  return report;
}
async function freezePhase(
  context: PhaseContext,
  pilot: Completion,
  pilotReport: PilotReport,
  catalogue: Catalogue,
  calibration: Completion,
  calibrationReport: CalibrationReport,
) {
  const { root, binding, ledger, ledgerPath } = context;
  check(
    calibration.ledgerHash === (await hashFile(ledgerPath)) &&
      ledger.snapshot().attempts.length === 1012,
    "Calibration ledger mutation.",
  );
  const frozen: Frozen = {
    binding,
    profile: pilotReport.selected,
    thresholds: calibrationReport.thresholds,
    questions: classifierWireQuestions(catalogue),
    extraction: binding.sources["classifier-request.ts"]!,
    suppression: binding.sources["selection.ts"]!,
    pilot,
    calibration,
    ledgerHash: await hashFile(ledgerPath),
    native: true,
  };
  await writeRecallNew(join(root, "frozen.json"), frozen);

  await writeRecallNew(artifact(root, "freeze", "observations.jsonl"), "No calls in freeze.");

  return frozen;
}
async function verifyPhase(
  context: PhaseContext,
  pilotReport: PilotReport,
  catalogue: Catalogue,
  calibrationReport: CalibrationReport,
) {
  const { o, root, m, binding, ledger, ledgerPath, ids } = context;
  const freeze = await completion(root, "freeze", binding);
  const frozen = await json<Frozen>(join(root, "frozen.json"));
  same(frozen, await json(artifact(root, "freeze", "report.json")), "Frozen artifact mutation.");
  same(frozen.binding, binding, "Frozen binding mutation.");
  same(frozen.thresholds, calibrationReport.thresholds, "Frozen threshold mutation.");
  same(frozen.questions, classifierWireQuestions(catalogue), "Frozen questions mutation.");
  check(isNative(frozen.native), "Frozen evidence is not native.");
  check(isNative(freeze.native), "Freeze completion is not native.");
  check(frozen.profile === pilotReport.selected, "Frozen profile mutation.");
  check(frozen.ledgerHash === (await hashFile(ledgerPath)), "Frozen ledger mutation.");
  check(ledger.snapshot().attempts.length === 1012, "Frozen attempt count mutation.");
  const rows = await readRecallFixtures(o.manifest, m.heldout, ids);
  check(
    m.repeats.every((id) => rows.some((r) => r.id === id)),
    "Unknown repeat IDs.",
  );
  const development = await readRecallFixtures(o.manifest, [...m.pilot, ...m.calibration], ids);
  const consumed = new Set(development.map((r) => normalizedPromptHash(r.prompt)));
  check(
    rows.every(
      (r) =>
        !consumed.has(normalizedPromptHash(r.prompt)) && !development.some((d) => d.id === r.id),
    ),
    "Heldout overlaps development.",
  );
  const syntheticRows = rows.filter((row) => row.kind === "synthetic");
  for (const id of ids) {
    check(
      syntheticRows.filter((r) => r.labels[id] === "positive" && !r.named.includes(id)).length >=
        10,
      "Heldout synthetic coverage gap.",
    );
  }
  check(
    rows.filter(
      (r) =>
        r.kind === "private" &&
        ids.some((id) => r.labels[id] === "positive" && !r.named.includes(id)),
    ).length >= 20,
    "Private positive coverage gap.",
  );
  const old10 = await readOldTenCutoffs(join(PACKAGE, "evals/production/policy.json"));
  const registry = await (
    o.createRegistry ?? (async () => createNativeRegistry(join(homedir(), ".pi/agent")))
  )();
  const observations = await collect(
    o,
    root,
    m,
    binding,
    ledger,
    registry,
    catalogue,
    rows,
    pilotReport.selected,
    m.repeats,
  );
  const result = acceptance(rows, observations, frozen.thresholds, old10);
  return verificationReport(result, observations, frozen.thresholds, ids, ledger.snapshot());
}
async function phaseReport(context: PhaseContext, native: boolean): Promise<unknown> {
  const { o, root, binding, profiles } = context;
  if (o.phase === "pilot") {
    return pilotPhase(context);
  }
  const pilot = await completion(root, "pilot", binding);
  const pilotReport = await json<PilotReport>(artifact(root, "pilot", "report.json"));
  check(
    pilotReport.selected === "baseline" || pilotReport.selected === "semanticRepair",
    "Invalid selected profile.",
  );
  const catalogue = profiles[pilotReport.selected];
  if (o.phase === "calibrate") {
    check(
      !native || isNative(pilot.native),
      "Native calibration requires a native pilot; injected evidence is not portable.",
    );
    return calibrationPhase(context, pilot, pilotReport, catalogue);
  }
  const calibration = await completion(root, "calibrate", binding);
  const calibrationReport = await json<CalibrationReport>(
    artifact(root, "calibrate", "report.json"),
  );
  assertDevelopment(
    calibrationReport.metrics,
    calibrationReport.thresholds,
    calibrationReport.gaps,
  );
  check(calibrationReport.profile === pilotReport.selected, "Selected profile mutation.");
  check(
    native && isNative(pilot.native) && isNative(calibration.native),
    "Injected/mock evidence cannot freeze or pass acceptance.",
  );
  if (o.phase === "freeze") {
    return freezePhase(context, pilot, pilotReport, catalogue, calibration, calibrationReport);
  }
  return verifyPhase(context, pilotReport, catalogue, calibrationReport);
}
export async function runRecallEvaluation(o: RecallEvaluationOptions): Promise<unknown> {
  check(["pilot", "calibrate", "freeze", "verify"].includes(o.phase), "Unknown phase.");
  const root = resolve(o.runDir ?? RECALL_RUN);
  check(
    resolve(o.manifest).startsWith(`${root}/`),
    "Manifest must be inside fixed private run directory.",
  );
  const m = await loadRecallManifest(o.manifest, root);
  const profiles = {
    baseline: await loadRecallCatalogue(join(PACKAGE, PROFILE_FILES.baseline)),
    semanticRepair: await loadRecallCatalogue(join(PACKAGE, PROFILE_FILES.semanticRepair)),
  };
  const ids = profiles.baseline.concepts.map((c) => c.id);
  same(
    ids,
    profiles.semanticRepair.concepts.map((c) => c.id),
    "Profile concept identities differ.",
  );
  // Definitions and runtime suppression vocabulary may not vary between question profiles.
  same(profiles.baseline.concepts, profiles.semanticRepair.concepts, "Profile definitions differ.");
  await validateRecallSeal(o.manifest, m, ids);
  const binding = await bindingAt(o, m);
  check(
    binding.authorization === binding.sources["evals/recall/authorization.json"],
    "Private authorization must match committed fresh authorization.",
  );
  const ledgerPath = join(root, "ledger.json");
  const planned = { pilot: 400, calibrate: 612, freeze: 0, verify: 774 }[o.phase];
  const currentLedger = await readRecallLedger(ledgerPath);
  check(previewRecallBudget(currentLedger, planned).fits, "Insufficient recall budget.");
  if (o.dryRun === true) {
    return {
      dryRun: true,
      phase: o.phase,
      planned,
      totalPlanned: RECALL_PLANNED_ATTEMPTS,
      binding,
      protocol,
      budget: previewRecallBudget(currentLedger, planned),
    };
  }
  check(
    o.runDir === undefined || (o.matcher !== undefined && o.createRegistry !== undefined),
    "A test-only runDir requires both injected matcher and registry; native collection uses the fixed run directory.",
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const ledger = await openRecallLedger(ledgerPath);
  try {
    // Burn before fixture reads, preflight and auth. Even duplicate preflight consumes this phase.
    await writeRecallNew(artifact(root, o.phase, "receipt.json"), {
      binding,
      phase: o.phase,
      burnedAt: new Date().toISOString(),
    });
    const native =
      o.createRegistry === undefined && o.matcher === undefined && o.runDir === undefined;
    const context: PhaseContext = { o, root, m, binding, ledger, ledgerPath, profiles, ids };
    const report = await phaseReport(context, native);
    await assertBinding(o, m, binding);
    if (o.phase !== "calibrate" && o.phase !== "pilot") {
      await writeRecallNew(artifact(root, o.phase, "report.json"), report);
    }
    await syncRecallEvidence(artifact(root, o.phase, "observations.jsonl"));
    const complete: Completion = {
      binding,
      native,
      ledgerHash: await hashFile(ledgerPath),
      reportHash: await hashFile(artifact(root, o.phase, "report.json")),
      observationsHash: await hashFile(artifact(root, o.phase, "observations.jsonl")),
    };
    await writeRecallNew(artifact(root, o.phase, "complete.json"), complete);
    return report;
  } finally {
    await ledger.close();
  }
}
export function recallExitCode(result: unknown): number {
  return Number(
    typeof result === "object" && result !== null && "passed" in result && result.passed === false,
  );
}
const entrypoint = process.argv[1];
const isMain =
  typeof entrypoint === "string" && resolve(entrypoint) === fileURLToPath(import.meta.url);
function isPhase(value: unknown): value is RecallEvaluationOptions["phase"] {
  return typeof value === "string" && ["pilot", "calibrate", "freeze", "verify"].includes(value);
}
if (isMain) {
  const { values } = parseArgs({
    options: {
      phase: { type: "string" },
      manifest: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  check(
    isPhase(values.phase) && typeof values.manifest === "string",
    "Usage: --phase pilot|calibrate|freeze|verify --manifest PATH [--dry-run]",
  );
  runRecallEvaluation({
    phase: values.phase,
    manifest: values.manifest,
    dryRun: values["dry-run"],
  })
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = recallExitCode(result);
      return undefined;
    })
    .catch(() => {
      process.stderr.write(
        "Recall phase refused/failed; inspect private artifacts. No resume or retry is authorized.\n",
      );
      process.exitCode = 1;
      return undefined;
    });
}
