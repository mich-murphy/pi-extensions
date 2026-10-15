import { createHash, randomUUID } from "node:crypto";
import { access, appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getAgentDir, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
// Pi does not export AuthStorage from the package root; the native fixtures import it from dist.
import { AuthStorage } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { criteriaHash, loadCatalogue } from "../catalogue";
import {
  BudgetError,
  INPUT_NANOS_PER_TOKEN,
  JEV_CAP_NANOS,
  JEV_PRICING_URL,
  OVERALL_CAP_NANOS,
  budgetTotals,
  ledgerPathFor,
  openLedger,
  previewBudget,
  readLedger,
} from "../eval-budget";
import type { BudgetPreview, LedgerSession } from "../eval-budget";
import { PRECISION_TARGET, meetsUsefulnessGate } from "../eval-metrics";
import type { EvalError, EvalFixture, EvalMetrics } from "../eval-metrics";
import { JEV_MODEL_ID, matchWithNativeClassifier } from "../native-matcher";
import type { NativeMatcherResult } from "../native-matcher";
import { suppressAlreadyNamed } from "../selection";
import type { Catalogue, Policy } from "../types";
import { stableHash } from "../validation";
import { chooseThreshold, metricsAt } from "./eval-screen";
import type { RawObservation } from "./eval-screen";
import { runOfflineOperation } from "./round-two-offline";
import type { OfflineOptions, OfflinePaths } from "./round-two-offline";
import {
  finishRound,
  isVariant,
  readRoundState,
  registerPrompts,
  reserveRoundAttempt,
  roundContext,
  roundError,
  roundPrefix,
  startRound,
} from "./round-two-state";
import type { RoundContext, Variant } from "./round-two-state";

export type Split = "development" | "heldout";
type SplitEntry = { readonly file: string; readonly sha256: string; readonly records: number };
type Manifest = Readonly<Record<Split, SplitEntry>>;

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELDOUT_REPETITIONS = 2;
const MAX_REPETITIONS = 5;
const CALL_BACKSTOP_MS = 30_000;
const FALLBACK_THRESHOLD = 0.95;

export class EvalCliError extends Error {
  override readonly name = "EvalCliError";
}

export type EvalRegistry = Pick<ModelRegistry, "findOfType" | "classify"> & {
  readonly getProviderAuthStatus: (provider: string) => { readonly configured: boolean };
};

export type RefreshableRegistry = Pick<ModelRegistry, "refresh">;

const TYPESAFE_PROVIDER = "typesafe";
const AUTH_REFRESH_TIMEOUT_MS = 10_000;

export type Matcher = (
  registry: EvalRegistry,
  catalogue: Catalogue,
  prompt: string,
  threshold: number,
  signal: AbortSignal,
) => Promise<NativeMatcherResult>;

export type EvalOptions = {
  readonly dataset?: "v2";
  readonly variant?: Variant;
  readonly split: Split;
  readonly repetitions: number;
  readonly outputDir: string;
  readonly dryRun: boolean;
  readonly writePolicy: boolean;
  readonly ledgerPath: string;
  readonly evalsDir: string;
  readonly policyPath: string;
  readonly createRegistry: () => Promise<EvalRegistry>;
  readonly matcher: Matcher;
  readonly runId: string;
  readonly now: () => Date;
};

export type EvalReport = {
  readonly outcome: "dry-run" | "policy-written" | "no-policy" | "passed" | "failed" | "error";
  readonly plannedAttempts: number;
  readonly budget: BudgetPreview;
  readonly threshold?: number;
  readonly metrics?: EvalMetrics;
  readonly errors: readonly EvalError[];
};

type Prep = {
  readonly round?: RoundContext;
  readonly options: EvalOptions;
  readonly entry: SplitEntry;
  readonly manifest: Manifest;
  readonly catalogue: Catalogue;
  readonly criteria: string;
  readonly policy: Policy | undefined;
  readonly planned: number;
  readonly preview: BudgetPreview;
};

type Run = Prep & {
  readonly registry: EvalRegistry;
  readonly ledger: LedgerSession;
  readonly fixtures: readonly EvalFixture[];
};

type AttemptResult =
  | { readonly ok: true; readonly observation: RawObservation }
  | { readonly ok: false; readonly error: EvalError };

type SweepRow = {
  readonly threshold: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly falsePositives: number;
  readonly meetsTarget: boolean;
};

type Evaluation = {
  readonly outcome: EvalReport["outcome"];
  readonly threshold: number;
  readonly metrics: EvalMetrics;
  readonly sweep?: readonly SweepRow[];
  readonly policy?: Policy;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Populates the SDK's cheap auth-status snapshot without model inference or remote catalog requests. */
export async function refreshTypesafeAuthSnapshot(registry: RefreshableRegistry): Promise<void> {
  try {
    const result = await registry.refresh({
      providers: [TYPESAFE_PROVIDER],
      allowNetwork: false,
      signal: AbortSignal.timeout(AUTH_REFRESH_TIMEOUT_MS),
    });
    if (result.aborted || result.errors.has(TYPESAFE_PROVIDER)) {
      throw new EvalCliError("The typesafe provider credential check failed.");
    }
  } catch {
    throw new EvalCliError("The typesafe provider credential check failed.");
  }
}

/** Builds the native registry through the SDK only: no ambient extensions, settings or catalogs. */
export async function createNativeRegistry(agentDir: string): Promise<EvalRegistry> {
  const runtime = await ModelRuntime.create({
    credentials: AuthStorage.create(join(agentDir, "auth.json")),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  await refreshTypesafeAuthSnapshot(registry);
  return registry;
}

function isEntry(value: unknown, split: Split): value is SplitEntry {
  return (
    isRecord(value) &&
    value.file === `${split}.json` &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(value.sha256) &&
    typeof value.records === "number" &&
    Number.isSafeInteger(value.records) &&
    value.records > 0
  );
}

async function readManifest(evalsDir: string): Promise<Manifest> {
  const value: unknown = JSON.parse(await readFile(join(evalsDir, "manifest.json"), "utf8"));
  if (
    !isRecord(value) ||
    !isEntry(value.development, "development") ||
    !isEntry(value.heldout, "heldout")
  ) {
    throw new EvalCliError("The fixture manifest is invalid.");
  }
  return { development: value.development, heldout: value.heldout };
}

function isFixture(value: unknown): value is EvalFixture {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.prompt === "string" &&
    value.prompt.length > 0 &&
    isStringArray(value.applicable) &&
    isStringArray(value.displayed)
  );
}

/** Loads one whitelisted split and verifies it against the manifest hash. */
async function loadFixtures(
  evalsDir: string,
  split: Split,
  entry: SplitEntry,
  catalogue: Catalogue,
): Promise<readonly EvalFixture[]> {
  const bytes = await readFile(join(evalsDir, entry.file));
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
    throw new EvalCliError(`The ${split} fixtures do not match the manifest hash.`);
  }
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(value) || value.length !== entry.records) {
    throw new EvalCliError(`The ${split} fixtures do not match the manifest record count.`);
  }
  const fixtures: EvalFixture[] = [];
  const known = new Set(catalogue.concepts.map((concept) => concept.id));
  for (const item of value as unknown[]) {
    if (!isFixture(item) || [...item.applicable, ...item.displayed].some((id) => !known.has(id))) {
      throw new EvalCliError(`The ${split} fixtures contain an invalid record.`);
    }
    if (
      new Set(item.applicable).size !== item.applicable.length ||
      new Set(item.displayed).size !== item.displayed.length ||
      item.displayed.some((id) => !item.applicable.includes(id))
    ) {
      throw new EvalCliError(`The ${split} fixtures contain inconsistent labels.`);
    }
    fixtures.push(item);
  }
  return fixtures;
}

function parsePolicy(text: string): Policy | undefined {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.model !== JEV_MODEL_ID ||
    typeof value.catalogueHash !== "string" ||
    typeof value.criteriaHash !== "string" ||
    typeof value.fixtureHash !== "string" ||
    typeof value.threshold !== "number" ||
    typeof value.measuredDisplayedPrecision !== "number" ||
    typeof value.measured !== "boolean"
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    model: JEV_MODEL_ID,
    catalogueHash: value.catalogueHash,
    criteriaHash: value.criteriaHash,
    fixtureHash: value.fixtureHash,
    threshold: value.threshold,
    measuredDisplayedPrecision: value.measuredDisplayedPrecision,
    measured: value.measured,
  };
}

async function readPolicyFile(path: string): Promise<Policy | undefined> {
  try {
    return parsePolicy(await readFile(path, "utf8"));
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function heldoutReceiptPath(ledgerPath: string): string {
  return join(dirname(ledgerPath), "heldout-receipt.json");
}

function frozenProblem(
  policy: Policy | undefined,
  catalogue: Catalogue,
  manifest: Manifest,
): string | undefined {
  if (policy === undefined) {
    return "there is no policy file";
  }
  if (policy.measured) {
    return "the policy is already measured and held-out data is single use";
  }
  if (policy.catalogueHash !== catalogue.hash || policy.criteriaHash !== criteriaHash(catalogue)) {
    return "the policy does not match the current catalogue and criteria";
  }
  if (policy.fixtureHash !== manifest.development.sha256) {
    return "the policy was not frozen from the manifest's development fixtures";
  }
  if (!(policy.threshold > 0 && policy.threshold <= 1)) {
    return "the policy threshold is invalid";
  }
  return policy.measuredDisplayedPrecision < PRECISION_TARGET
    ? "the development policy did not reach the precision target"
    : undefined;
}

function validateOptions(options: EvalOptions): void {
  const { repetitions, split, outputDir, dryRun } = options;
  if (
    options.dataset === "v2" &&
    (repetitions !== 2 ||
      (split === "development" && !isVariant(options.variant)) ||
      (split === "heldout" && options.variant !== undefined) ||
      (options.writePolicy && split === "development"))
  ) {
    throw new EvalCliError(
      "V2 requires two repetitions, a fixed development variant, and offline joint policy selection.",
    );
  }
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > MAX_REPETITIONS) {
    throw new EvalCliError(`Repetitions must be an integer from 1 to ${String(MAX_REPETITIONS)}.`);
  }
  if (split === "heldout" && repetitions !== HELDOUT_REPETITIONS) {
    throw new EvalCliError(
      `The held-out split runs exactly ${String(HELDOUT_REPETITIONS)} repetitions.`,
    );
  }
  if (!dryRun && outputDir === "") {
    throw new EvalCliError("A real run needs an output directory.");
  }
}

function preparationCatalogue(
  options: EvalOptions,
  round: RoundContext | undefined,
  manifest: Manifest,
): Catalogue {
  const { catalogue: currentCatalogue } = loadCatalogue();
  const catalogue =
    round !== undefined && options.variant !== undefined
      ? round.candidates[options.variant].catalogue
      : currentCatalogue;
  if (
    round !== undefined &&
    (manifest.development.records !== 30 || manifest.heldout.records !== 40)
  ) {
    throw roundError("expected 30 development and 40 held-out prompts");
  }
  return catalogue;
}

async function prepare(options: EvalOptions): Promise<Prep> {
  validateOptions(options);
  const manifest = await readManifest(options.evalsDir);
  const round =
    options.dataset === "v2" ? await roundContext(options.evalsDir, options.ledgerPath) : undefined;
  const catalogue = preparationCatalogue(options, round, manifest);
  const policy = await readPolicyFile(options.policyPath);
  if (options.split === "heldout") {
    const problem = frozenProblem(policy, catalogue, manifest);
    if (problem !== undefined) {
      throw new EvalCliError(`Held-out run refused: ${problem}.`);
    }
    if (round === undefined && (await exists(heldoutReceiptPath(options.ledgerPath)))) {
      throw new EvalCliError("Held-out run refused: a held-out run was already started.");
    }
  }
  if (options.writePolicy && policy?.measured === true) {
    throw new EvalCliError("Refusing to overwrite a measured policy.");
  }
  const entry = manifest[options.split];
  const planned = entry.records * options.repetitions;
  const preview = previewBudget(await readLedger(options.ledgerPath), planned);
  if (!preview.fits) {
    throw new BudgetError("The planned attempts do not fit the budget; refusing before any call.");
  }
  return {
    ...(round === undefined ? {} : { round }),
    options,
    entry,
    manifest,
    catalogue,
    criteria: criteriaHash(catalogue),
    policy,
    planned,
    preview,
  };
}

function measuredPolicy(
  run: Run,
  metrics: EvalMetrics,
  threshold: number,
  measured: boolean,
): Policy {
  const fixtureHash = measured ? run.manifest.heldout.sha256 : run.manifest.development.sha256;
  return {
    schemaVersion: 1,
    model: JEV_MODEL_ID,
    catalogueHash: run.catalogue.hash,
    criteriaHash: run.criteria,
    fixtureHash,
    threshold,
    measuredDisplayedPrecision: metrics.displayed.precision ?? 0,
    measured,
  };
}

function evaluateDevelopment(run: Run, raws: readonly RawObservation[]): Evaluation {
  const { rows, best } = chooseThreshold(run, raws);
  if (best === undefined) {
    const threshold = 0.99;
    return {
      outcome: "no-policy",
      threshold,
      metrics: metricsAt(run, raws, [], threshold),
      sweep: rows,
    };
  }
  const policy = measuredPolicy(run, best.metrics, best.threshold, false);
  return {
    outcome: "policy-written",
    threshold: best.threshold,
    metrics: best.metrics,
    sweep: rows,
    policy,
  };
}

function evaluateHeldout(run: Run, raws: readonly RawObservation[]): Evaluation {
  const threshold = run.policy?.threshold ?? FALLBACK_THRESHOLD;
  const metrics = metricsAt(run, raws, [], threshold);
  if (
    !metrics.displayed.meetsPrecisionTarget ||
    (run.round !== undefined &&
      !meetsUsefulnessGate(
        metrics,
        run.catalogue.concepts.map((concept) => concept.id),
      ))
  ) {
    return { outcome: "failed", threshold, metrics };
  }
  return {
    outcome: "passed",
    threshold,
    metrics,
    policy: measuredPolicy(run, metrics, threshold, true),
  };
}

function evaluate(
  run: Run,
  raws: readonly RawObservation[],
  errors: readonly EvalError[],
): Evaluation {
  if (errors.length > 0) {
    const threshold = run.policy?.threshold ?? FALLBACK_THRESHOLD;
    return { outcome: "error", threshold, metrics: metricsAt(run, raws, errors, threshold) };
  }
  return run.options.split === "development"
    ? evaluateDevelopment(run, raws)
    : evaluateHeldout(run, raws);
}

async function callMatcher(run: Run, prompt: string): Promise<NativeMatcherResult | undefined> {
  try {
    return await run.options.matcher(
      run.registry,
      run.catalogue,
      prompt,
      0,
      AbortSignal.timeout(CALL_BACKSTOP_MS),
    );
  } catch {
    return undefined;
  }
}

function validMatches(
  catalogue: Catalogue,
  matches: readonly { readonly concept: { readonly id: string }; readonly probability: number }[],
): boolean {
  const ids = matches.map((match) => match.concept.id);
  return (
    matches.length === catalogue.recognition.length &&
    new Set(ids).size === ids.length &&
    matches.every(
      (match) =>
        catalogue.recognition.some((recognition) => recognition.conceptId === match.concept.id) &&
        Number.isFinite(match.probability) &&
        match.probability >= 0 &&
        match.probability <= 1,
    )
  );
}

function roundKey(options: EvalOptions): Variant | "heldout" {
  if (options.split === "heldout") {
    return "heldout";
  }
  if (!isVariant(options.variant)) {
    throw roundError("missing development variant");
  }
  return options.variant;
}

function failureMessage(outcome: NativeMatcherResult | undefined): string {
  if (outcome === undefined) {
    return "The classifier call threw.";
  }
  return outcome.ok
    ? "The classifier omitted or repeated concepts."
    : `The classifier call failed (${outcome.reason}).`;
}

async function attempt(run: Run, fixture: EvalFixture, repeat: number): Promise<AttemptResult> {
  const prefix =
    run.round === undefined
      ? `${run.options.runId}/${run.options.split}/`
      : roundPrefix(roundKey(run.options));
  const recordId = `${prefix}${fixture.id}/${String(repeat)}`;
  const fail = (message: string): AttemptResult => ({
    ok: false,
    error: { id: fixture.id, repeat, message },
  });
  if (run.round === undefined) {
    await run.ledger.reserve(recordId);
  } else {
    await reserveRoundAttempt(run.ledger, roundKey(run.options), recordId);
  }
  const started = performance.now();
  const outcome = await callMatcher(run, fixture.prompt);
  const latencyMs = Math.round(performance.now() - started);
  if (outcome?.ok !== true || !validMatches(run.catalogue, outcome.value.matches)) {
    await run.ledger.settleFailure(recordId);
    return fail(failureMessage(outcome));
  }
  try {
    const settled = await run.ledger.settleSuccess(recordId, outcome.value.usage);
    const probabilities = Object.fromEntries(
      outcome.value.matches.map((match) => [match.concept.id, match.probability]),
    );
    const inputTokens = settled.inputTokens ?? 0;
    const outputTokens = settled.outputTokens ?? 0;
    return {
      ok: true,
      observation: { id: fixture.id, repeat, probabilities, latencyMs, inputTokens, outputTokens },
    };
  } catch (error: unknown) {
    if (error instanceof BudgetError) {
      return fail("The response usage was missing or invalid.");
    }
    throw error;
  }
}

async function safeAttempt(run: Run, fixture: EvalFixture, repeat: number): Promise<AttemptResult> {
  try {
    return await attempt(run, fixture, repeat);
  } catch (error: unknown) {
    const message = error instanceof BudgetError ? error.message : "Unexpected failure.";
    return { ok: false, error: { id: fixture.id, repeat, message } };
  }
}

type Step = { readonly fixture: EvalFixture; readonly repeat: number };
type Collected = { readonly observations: RawObservation[]; readonly errors: EvalError[] };

/** Serial on purpose: one request at a time, stopping at the first error. */
async function collectFrom(
  run: Run,
  steps: readonly Step[],
  index: number,
  collected: Collected,
): Promise<Collected> {
  const step = steps[index];
  if (step === undefined) {
    return collected;
  }
  const result = await safeAttempt(run, step.fixture, step.repeat);
  if (!result.ok) {
    collected.errors.push(result.error);
    return collected;
  }
  collected.observations.push(result.observation);
  const line = `${JSON.stringify(result.observation)}\n`;
  await appendFile(join(run.options.outputDir, "observations.jsonl"), line);
  return collectFrom(run, steps, index + 1, collected);
}

async function writeNew(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

async function replaceFile(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

async function createOutputDir(outputDir: string): Promise<void> {
  await mkdir(dirname(outputDir), { recursive: true });
  try {
    await mkdir(outputDir);
  } catch (error: unknown) {
    if (hasCode(error, "EEXIST")) {
      throw new EvalCliError("The output directory already exists; refusing to mix runs.");
    }
    throw error;
  }
}

/** Writes the freeze receipt before the held-out fixtures are loaded. A receipt makes the split single use. */
async function writeFreezeReceipts(prep: Prep): Promise<void> {
  const receipt = {
    schemaVersion: 1,
    runId: prep.options.runId,
    frozenAt: prep.options.now().toISOString(),
    policyHash: stableHash(prep.policy),
    catalogueHash: prep.catalogue.hash,
    criteriaHash: prep.criteria,
    developmentFixtureHash: prep.manifest.development.sha256,
    heldoutFixtureHash: prep.manifest.heldout.sha256,
    threshold: prep.policy?.threshold ?? null,
  };
  try {
    await writeNew(heldoutReceiptPath(prep.options.ledgerPath), receipt);
  } catch (error: unknown) {
    if (hasCode(error, "EEXIST")) {
      throw new EvalCliError("Held-out run refused: a held-out run was already started.");
    }
    throw error;
  }
  await writeNew(join(prep.options.outputDir, "freeze-receipt.json"), receipt);
}

function budgetSummary(run: Run) {
  const snapshot = run.ledger.snapshot();
  const mine = snapshot.attempts.filter((item) =>
    item.recordId.startsWith(
      run.round === undefined ? `${run.options.runId}/` : roundPrefix(roundKey(run.options)),
    ),
  );
  const own = budgetTotals({ ...snapshot, attempts: mine });
  return {
    pricingUrl: JEV_PRICING_URL,
    inputNanosPerToken: INPUT_NANOS_PER_TOKEN,
    outputPriced: false,
    documentedTotalInputTokenLimit: 65_536,
    documentedStatePlusLongestQuestionTokenLimit: 32_000,
    jevCapNanos: JEV_CAP_NANOS,
    overallCapNanos: OVERALL_CAP_NANOS,
    run: {
      attempts: own.attempts,
      reservedNanos: own.jevReservedNanos,
      observedNanos: own.jevObservedNanos,
    },
    cumulative: budgetTotals(snapshot),
  };
}

function summarize(run: Run, evaluation: Evaluation, errors: readonly EvalError[]) {
  const { options } = run;
  return {
    schemaVersion: 1,
    ...(run.round === undefined
      ? {}
      : { dataset: "v2", variant: options.variant ?? null, binding: run.round.binding }),
    runId: options.runId,
    split: options.split,
    outcome: evaluation.outcome,
    date: options.now().toISOString(),
    requestedModel: JEV_MODEL_ID,
    modelNote: "The requested model id; the serving model is not reported.",
    hashes: {
      catalogue: run.catalogue.hash,
      criteria: run.criteria,
      fixture: run.entry.sha256,
    },
    prompts: run.fixtures.length,
    repetitions: options.repetitions,
    plannedAttempts: run.planned,
    threshold: evaluation.threshold,
    thresholdSource: options.split === "development" ? "offline sweep" : "frozen policy",
    metrics: evaluation.metrics,
    sweep: evaluation.sweep ?? null,
    errors,
    budget: budgetSummary(run),
    limitations: [
      "Small synthetic screening set, not representative private-prompt validation.",
      "Repeated attempts are not independent prompts; the Wilson interval is descriptive only.",
      "Acceptance is the 95 percent precision point estimate over the selected-term group screen.",
      "TypeSafe documents a 64k-token total input limit and a 32k-token state plus longest-question sublimit; these public fixtures are tiny.",
    ],
  };
}

async function persist(
  run: Run,
  evaluation: Evaluation,
  errors: readonly EvalError[],
): Promise<void> {
  const { policy } = evaluation;
  if (policy !== undefined) {
    await writeNew(join(run.options.outputDir, "policy.json"), policy);
  }
  await writeNew(join(run.options.outputDir, "run.json"), summarize(run, evaluation, errors));
}

/** Publish only after all artifacts and native completion provenance have been sealed. */
async function publishPolicy(run: Run, evaluation: Evaluation): Promise<void> {
  if (
    evaluation.policy !== undefined &&
    run.options.writePolicy &&
    !(run.round !== undefined && run.options.split === "development")
  ) {
    await replaceFile(run.options.policyPath, evaluation.policy);
  }
}

async function validateRoundFreeze(prep: Prep, ledger: LedgerSession): Promise<void> {
  if (prep.round === undefined) {
    return;
  }
  const state = await readRoundState(prep.round, ledger);
  if (prep.options.split === "development") {
    if (state.freeze !== null) {
      throw roundError("development cannot run after policy freeze");
    }
    return;
  }
  if (
    state.freeze === null ||
    stableHash(prep.policy) !== stableHash(state.freeze.policy) ||
    prep.catalogue.hash !== prep.round.candidates[state.freeze.candidate].catalogue.hash
  ) {
    throw roundError("runtime core or policy does not exactly match the selected frozen candidate");
  }
}

function validateHeldoutCoverage(fixtures: readonly EvalFixture[], catalogue: Catalogue): void {
  for (const concept of catalogue.concepts) {
    const eligible = new Set(
      fixtures
        .filter(
          (fixture) =>
            fixture.displayed.includes(concept.id) &&
            !suppressAlreadyNamed(fixture.prompt, catalogue).has(concept.id),
        )
        .map((fixture) => fixture.prompt.normalize("NFKC").trim()),
    );
    if (eligible.size < 4) {
      throw roundError("held-out set needs four distinct eligible positives per concept");
    }
  }
}

async function runFixtures(
  prep: Prep,
  ledger: LedgerSession,
): Promise<{ readonly fixtures: readonly EvalFixture[]; readonly errors: EvalError[] }> {
  try {
    const fixtures = await loadFixtures(
      prep.options.evalsDir,
      prep.options.split,
      prep.entry,
      prep.catalogue,
    );
    if (prep.round !== undefined) {
      await registerPrompts(prep.round, ledger, roundKey(prep.options), fixtures);
      if (prep.options.split === "heldout") {
        validateHeldoutCoverage(fixtures, prep.catalogue);
      }
    }
    return { fixtures, errors: [] };
  } catch (error: unknown) {
    if (prep.round === undefined) {
      throw error;
    }
    return {
      fixtures: [],
      errors: [
        {
          id: "fixture-preflight",
          repeat: 0,
          message: "Fixture integrity, freshness or eligible-positive coverage failed.",
        },
      ],
    };
  }
}

async function executeRun(prep: Prep): Promise<EvalReport> {
  const { options } = prep;
  const registry = await options.createRegistry();
  if (!registry.getProviderAuthStatus(TYPESAFE_PROVIDER).configured) {
    throw new EvalCliError("The typesafe provider has no configured credentials.");
  }
  const ledger = await openLedger(options.ledgerPath, options.now);
  try {
    if (!previewBudget(ledger.snapshot(), prep.planned).fits) {
      throw new BudgetError(
        "The planned attempts do not fit the budget; refusing before any call.",
      );
    }
    await createOutputDir(options.outputDir);
    if (prep.round !== undefined) {
      await validateRoundFreeze(prep, ledger);
      await startRound(prep.round, ledger, roundKey(options), options.runId, options.outputDir);
      const candidate =
        options.variant === undefined ? undefined : prep.round.candidates[options.variant];
      const text =
        candidate?.text ?? (await readFile(join(PACKAGE_DIR, "glossary", "core.json"), "utf8"));
      await writeFile(join(options.outputDir, "candidate.json"), text, { flag: "wx" });
      await writeNew(
        join(options.outputDir, "questions.json"),
        prep.catalogue.recognition.map((recognition) => [
          recognition.conceptId,
          recognition.question,
        ]),
      );
      await writeFile(join(options.outputDir, "observations.jsonl"), "", { flag: "wx" });
    } else if (options.split === "heldout") {
      await writeFreezeReceipts(prep);
    }
    const { fixtures, errors: fixtureErrors } = await runFixtures(prep, ledger);
    const run: Run = { ...prep, registry, ledger, fixtures };
    const steps = fixtures.flatMap((fixture) =>
      Array.from({ length: options.repetitions }, (_, repeat) => ({ fixture, repeat })),
    );
    const { observations, errors } = await collectFrom(run, steps, 0, {
      observations: [],
      errors: fixtureErrors,
    });
    const evaluation = evaluate(run, observations, errors);
    await persist(run, evaluation, errors);
    if (prep.round !== undefined) {
      await finishRound(prep.round, ledger, roundKey(options), options.outputDir);
    }
    await publishPolicy(run, evaluation);
    return {
      outcome: evaluation.outcome,
      plannedAttempts: prep.planned,
      budget: prep.preview,
      threshold: evaluation.threshold,
      metrics: evaluation.metrics,
      errors,
    };
  } finally {
    await ledger.close();
  }
}

/**
 * Dry runs read the existing ledger and policy only: no credentials, no ledger, output or policy
 * files. A real run reserves every attempt in full before its call and stops at the first error.
 */
export async function runEvaluation(options: EvalOptions): Promise<EvalReport> {
  const prep = await prepare(options);
  if (options.dryRun) {
    return { outcome: "dry-run", plannedAttempts: prep.planned, budget: prep.preview, errors: [] };
  }
  return executeRun(prep);
}

export type CliArgs = OfflineOptions & {
  readonly dataset?: "v2";
  readonly variant?: Variant;
  readonly operation?: "select" | "freeze";
  readonly instructionsRun?: string;
  readonly criteriaRun?: string;
  readonly selection?: string;
  readonly split: Split;
  readonly repetitions: number;
  readonly output: string;
  readonly dryRun: boolean;
  readonly writePolicy: boolean;
};

export function parseCli(argv: readonly string[]): CliArgs {
  let values: ReturnType<typeof parseArgs>["values"];
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      options: {
        split: { type: "string" },
        dataset: { type: "string" },
        variant: { type: "string" },
        operation: { type: "string" },
        "instructions-run": { type: "string" },
        "criteria-run": { type: "string" },
        selection: { type: "string" },
        repetitions: { type: "string", default: "2" },
        output: { type: "string", default: "" },
        "dry-run": { type: "boolean", default: false },
        "write-policy": { type: "boolean", default: false },
      },
    }));
  } catch {
    throw new EvalCliError(
      "Invalid arguments. Use --split development|heldout --repetitions 2 --output DIR [--dry-run].",
    );
  }
  const { split, repetitions, output } = values;
  const extra = roundCli(values);
  if (split !== "development" && split !== "heldout" && extra.operation === undefined) {
    throw new EvalCliError("--split must be development or heldout.");
  }
  return {
    ...extra,
    split: split === "heldout" ? "heldout" : "development",
    repetitions: Number(repetitions),
    output: typeof output === "string" ? output : "",
    dryRun: values["dry-run"] === true,
    writePolicy: values["write-policy"] === true,
  };
}

function validateOfflineFlags(values: ReturnType<typeof parseArgs>["values"]): void {
  const operation = values.operation;
  if (
    operation === undefined &&
    [values["instructions-run"], values["criteria-run"], values.selection].some(
      (value) => value !== undefined,
    )
  ) {
    throw new EvalCliError("Artifact paths require an explicit offline operation.");
  }
  if (
    operation !== undefined &&
    (values.variant !== undefined ||
      values.split !== undefined ||
      values["dry-run"] === true ||
      values["write-policy"] === true)
  ) {
    throw new EvalCliError("Offline operations cannot dispatch or use run flags.");
  }
}

function roundCli(
  values: ReturnType<typeof parseArgs>["values"],
): Pick<
  CliArgs,
  "dataset" | "variant" | "operation" | "instructionsRun" | "criteriaRun" | "selection"
> {
  if (values.dataset === undefined) {
    if (
      [
        values.variant,
        values.operation,
        values["instructions-run"],
        values["criteria-run"],
        values.selection,
      ].some((value) => value !== undefined)
    ) {
      throw new EvalCliError("Round-two flags require --dataset v2.");
    }
    return {};
  }
  if (values.dataset !== "v2") {
    throw new EvalCliError("Only --dataset v2 is allowed.");
  }
  if (values.variant !== undefined && !isVariant(values.variant)) {
    throw new EvalCliError("Unknown candidate variant.");
  }
  const operation = values.operation;
  if (operation !== undefined && operation !== "select" && operation !== "freeze") {
    throw new EvalCliError("Unknown offline operation.");
  }
  validateOfflineFlags(values);
  return {
    dataset: "v2",
    ...(isVariant(values.variant) ? { variant: values.variant } : {}),
    ...(operation === undefined ? {} : { operation }),
    ...(typeof values["instructions-run"] === "string"
      ? { instructionsRun: values["instructions-run"] }
      : {}),
    ...(typeof values["criteria-run"] === "string" ? { criteriaRun: values["criteria-run"] } : {}),
    ...(typeof values.selection === "string" ? { selection: values.selection } : {}),
  };
}

function describeReport(report: EvalReport): string {
  const { displayed } = report.metrics ?? {};
  return `${JSON.stringify(
    {
      outcome: report.outcome,
      plannedAttempts: report.plannedAttempts,
      budget: report.budget,
      threshold: report.threshold ?? null,
      displayed: displayed ?? null,
      errors: report.errors,
    },
    null,
    2,
  )}\n`;
}

const SUCCESS = new Set<EvalReport["outcome"]>(["dry-run", "policy-written", "passed"]);

export type EvalCliDependencies = {
  readonly agentDir: () => string;
  readonly stdout: Pick<typeof process.stdout, "write">;
  readonly stderr: Pick<typeof process.stderr, "write">;
  readonly runId: () => string;
  readonly now: () => Date;
  readonly createRegistry: (agentDir: string) => Promise<EvalRegistry>;
  readonly matcher: Matcher;
};

export async function runCli(
  argv: readonly string[],
  dependencies: EvalCliDependencies = defaultCliDependencies(),
): Promise<number> {
  try {
    const cli = parseCli(argv);
    if (cli.operation !== undefined) {
      const offlinePaths: OfflinePaths = {
        ledgerPath: ledgerPathFor(dependencies.agentDir()),
        evalsDir: join(PACKAGE_DIR, "evals", "v2"),
        policyPath: join(PACKAGE_DIR, "glossary", "policy.json"),
        now: dependencies.now,
      };
      const result = await runOfflineOperation(cli, offlinePaths);
      dependencies.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.outcome === "no-policy" ? 1 : 0;
    }
    const report = await runEvaluation(cliOptions(cli, dependencies));
    dependencies.stdout.write(describeReport(report));
    return SUCCESS.has(report.outcome) ? 0 : 1;
  } catch (error: unknown) {
    dependencies.stderr.write(`${cliErrorMessage(error)}\n`);
    return 1;
  }
}

function cliOptions(cli: CliArgs, dependencies: EvalCliDependencies): EvalOptions {
  const agentDir = dependencies.agentDir();
  return {
    ...(cli.dataset === undefined ? {} : { dataset: cli.dataset }),
    ...(cli.variant === undefined ? {} : { variant: cli.variant }),
    split: cli.split,
    repetitions: cli.repetitions,
    outputDir: cli.output === "" ? "" : resolve(cli.output),
    dryRun: cli.dryRun,
    writePolicy: cli.writePolicy,
    ledgerPath: ledgerPathFor(agentDir),
    evalsDir: cli.dataset === "v2" ? join(PACKAGE_DIR, "evals", "v2") : join(PACKAGE_DIR, "evals"),
    policyPath: join(PACKAGE_DIR, "glossary", "policy.json"),
    createRegistry: async () => dependencies.createRegistry(agentDir),
    matcher: dependencies.matcher,
    runId: dependencies.runId(),
    now: dependencies.now,
  };
}

function cliErrorMessage(error: unknown): string {
  return error instanceof EvalCliError || error instanceof BudgetError
    ? error.message
    : "The evaluation failed unexpectedly.";
}

function defaultCliDependencies(): EvalCliDependencies {
  return {
    agentDir: getAgentDir,
    stdout: process.stdout,
    stderr: process.stderr,
    runId: randomUUID,
    now: () => new Date(),
    createRegistry: createNativeRegistry,
    matcher: matchWithNativeClassifier,
  };
}

const meta = import.meta as ImportMeta & { readonly main?: boolean };
if (
  meta.main ||
  (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
) {
  process.exitCode = await runCli(process.argv.slice(2));
}
