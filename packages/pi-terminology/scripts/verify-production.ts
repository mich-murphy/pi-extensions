/* eslint-disable no-await-in-loop -- Sequential validation and dispatch stop at the first failure; reservations must be durable before inference. */
import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ClassifierResult } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { criteriaHash, isPolicy, loadCatalogue } from "../catalogue";
import { extractClassifierText } from "../classifier-request";
import { budgetTotals, observeUsage, openLedger, previewBudget, readLedger } from "../eval-budget";
import type { BudgetPreview, LedgerSession } from "../eval-budget";
import { matchWithNativeClassifier } from "../native-matcher";
import type { NativeClassifierRegistry } from "../native-matcher";
import { computeRealPromptMetrics } from "../real-prompt-metrics";
import type {
  RealPromptGold,
  RealPromptLabel,
  RealPromptMetrics,
  RealPromptObservation,
  RealPromptSelections,
} from "../real-prompt-metrics";
import { selectMatches, suppressAlreadyNamed } from "../selection";
import type { Catalogue, Policy } from "../types";
import { stableHash } from "../validation";
import { createNativeRegistry } from "./evaluate";
import type { EvalRegistry } from "./evaluate";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = join(PACKAGE_DIR, "glossary", "policy.json");
const MAX_CALLS = 360;
const PRECISION_TARGET = 0.9;
const EMPTY_STATE = {
  hiddenConceptIds: new Set<string>(),
  dismissedConceptIds: new Set<string>(),
  cooldowns: new Map<string, number>(),
};

type Fixture = {
  readonly id: string;
  readonly prompt: string;
  readonly labels: Readonly<Record<string, RealPromptLabel>>;
  readonly named: readonly string[];
};
type Dataset = {
  readonly name: string;
  readonly kind: "private" | "synthetic";
  readonly sha256: string;
  readonly records: number;
  readonly fixtures: readonly Fixture[];
};

export type ProductionRegistry = NativeClassifierRegistry &
  Pick<EvalRegistry, "getProviderAuthStatus">;

export type ProductionVerificationOptions = {
  readonly manifest: string;
  readonly output: string;
  readonly dryRun?: boolean;
  readonly writePolicy?: boolean;
  /** Dependency injection is available to local tests only, never through CLI flags. */
  readonly createRegistry?: () => Promise<ProductionRegistry>;
  readonly matcher?: typeof matchWithNativeClassifier;
  readonly catalogue?: Catalogue;
  readonly policy?: Policy;
  readonly agentDir?: string;
};

type Prepared = {
  readonly catalogue: Catalogue;
  readonly policy: Policy;
  readonly datasets: readonly Dataset[];
  readonly manifestHash: string;
  readonly catalogueSnapshot: string;
  readonly criteria: string;
  readonly policySnapshot: string;
  readonly plannedCalls: number;
};

export type AggregateMetrics = Pick<RealPromptMetrics, "prompts" | "attempts" | "overall"> & {
  readonly perConcept: Readonly<
    Record<string, Omit<RealPromptMetrics["perConcept"][string], "distinctPromptEvidence">>
  >;
};
export type ProductionVerificationReport = {
  readonly schemaVersion: 1;
  readonly outcome: "dry-run" | "passed" | "failed" | "error";
  readonly plannedCalls: number;
  readonly maxCalls: 360;
  readonly repeats: 1;
  readonly retries: 0;
  readonly precisionTarget: 0.9;
  readonly budget: BudgetPreview;
  readonly provenance: ReturnType<typeof receiptFor>;
  readonly metrics?: {
    readonly overall: AggregateMetrics;
    readonly datasets: readonly {
      readonly kind: "private" | "synthetic";
      readonly metrics: AggregateMetrics;
    }[];
    readonly private?: AggregateMetrics;
    readonly synthetic: AggregateMetrics;
  };
  readonly ledger?: ReturnType<typeof budgetTotals> & {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly nativeCostUsd: number | null;
  };
  readonly policyWritten: boolean;
  /** Deliberately generic: provider errors can contain private prompt text. */
  readonly error?: string;
};

function check(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isLabel(value: unknown): value is RealPromptLabel {
  return value === "positive" || value === "negative" || value === "ambiguous";
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
async function requireAbsent(path: string, message: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error: unknown) {
    if (record(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(message);
}

function validateFixture(value: unknown, ids: readonly string[], seen: Set<string>): Fixture {
  check(record(value), "Invalid fixture record.");
  check(text(value.id) && !seen.has(value.id), "Fixture IDs must be nonempty and globally unique.");
  check(text(value.prompt), "Fixture prompt must be nonempty.");
  check(record(value.labels), "Fixture labels must be explicit for every concept.");
  const labels = value.labels;
  check(
    Object.keys(labels).length === ids.length &&
      ids.every((id) => Object.hasOwn(labels, id) && isLabel(labels[id])),
    "Fixture labels must cover exactly the known concepts.",
  );
  check(
    Array.isArray(value.named) &&
      new Set(value.named).size === value.named.length &&
      value.named.every(
        (id: unknown) => typeof id === "string" && ids.includes(id) && labels[id] === "positive",
      ),
    "Named concepts must be unique known positive concepts.",
  );
  seen.add(value.id);
  return {
    id: value.id,
    prompt: value.prompt,
    labels: Object.fromEntries(
      ids.map((id) => {
        const label = labels[id];
        check(isLabel(label), "Invalid label.");
        return [id, label];
      }),
    ),
    named: value.named.filter((id: unknown): id is string => typeof id === "string"),
  };
}

async function readDatasets(manifestPath: string, catalogue: Catalogue) {
  const bytes = await readFile(manifestPath);
  const manifest: unknown = JSON.parse(bytes.toString("utf8"));
  check(
    record(manifest) &&
      manifest.schemaVersion === 1 &&
      manifest.precisionTarget === PRECISION_TARGET,
    "Manifest must declare schemaVersion 1 and precisionTarget 0.90.",
  );
  check(
    Array.isArray(manifest.datasets) && manifest.datasets.length > 0,
    "Datasets must be nonempty.",
  );
  const ids = catalogue.concepts.map((concept) => concept.id);
  check(
    ids.length > 0 &&
      catalogue.recognition.length === ids.length &&
      ids.every((id) => catalogue.recognition.some((item) => item.conceptId === id)),
    "Every concept must have production recognition criteria.",
  );
  const seen = new Set<string>();
  const names = new Set<string>();
  const datasets: Dataset[] = [];
  for (const entry of manifest.datasets as unknown[]) {
    check(
      record(entry) &&
        text(entry.name) &&
        !names.has(entry.name) &&
        (entry.kind === "private" || entry.kind === "synthetic") &&
        text(entry.file) &&
        typeof entry.sha256 === "string" &&
        /^[0-9a-f]{64}$/u.test(entry.sha256) &&
        typeof entry.records === "number" &&
        Number.isSafeInteger(entry.records) &&
        entry.records > 0,
      "Invalid dataset commitment.",
    );
    names.add(entry.name);
    const data = await readFile(resolve(dirname(manifestPath), entry.file));
    check(hashBytes(data) === entry.sha256, "Dataset SHA-256 mismatch.");
    const fixtures: unknown = JSON.parse(data.toString("utf8"));
    check(
      Array.isArray(fixtures) && fixtures.length === entry.records,
      "Dataset record count mismatch.",
    );
    datasets.push({
      name: entry.name,
      kind: entry.kind,
      sha256: entry.sha256,
      records: entry.records,
      fixtures: (fixtures as unknown[]).map((fixture) => validateFixture(fixture, ids, seen)),
    });
  }
  const count = (kind: Dataset["kind"]) =>
    datasets.filter((set) => set.kind === kind).reduce((sum, set) => sum + set.records, 0);
  check(
    count("private") <= 280 && count("synthetic") > 0 && count("synthetic") <= 80,
    "Plan must contain at most 280 private and 1–80 synthetic prompts, each run once.",
  );
  const publicFixtures = datasets
    .filter((set) => set.kind === "synthetic")
    .flatMap((set) => set.fixtures);
  check(
    ids.every((id) =>
      publicFixtures.some(
        (fixture) => fixture.labels[id] === "positive" && !fixture.named.includes(id),
      ),
    ),
    "Every concept needs an unnamed public synthetic positive.",
  );
  return { datasets, manifestHash: hashBytes(bytes) };
}

async function currentInputs(options: ProductionVerificationOptions) {
  const catalogue = options.catalogue ?? loadCatalogue().catalogue;
  // Read the raw policy, not loadCatalogue's deliberately forgiving runtime fallback.
  const policy: unknown = options.policy ?? JSON.parse(await readFile(POLICY_PATH, "utf8"));
  check(
    isPolicy(policy, catalogue) &&
      !policy.measured &&
      policy.precisionTarget === PRECISION_TARGET &&
      policy.catalogueHash === catalogue.hash &&
      policy.criteriaHash === criteriaHash(catalogue) &&
      policy.conceptThresholds !== undefined,
    "Verification requires a current, explicit unmeasured policy with the complete threshold map and precisionTarget 0.90.",
  );
  return { catalogue, policy };
}

async function prepare(options: ProductionVerificationOptions): Promise<Prepared> {
  const { catalogue, policy } = await currentInputs(options);
  const data = await readDatasets(resolve(options.manifest), catalogue);
  // Clone all caller-owned inputs before registry construction can mutate them.
  return structuredClone({
    ...data,
    catalogue,
    policy,
    criteria: criteriaHash(catalogue),
    catalogueSnapshot: stableHash(catalogue),
    policySnapshot: stableHash(policy),
    plannedCalls: data.datasets.reduce((sum, set) => sum + set.records, 0),
  });
}

function receiptFor(prepared: Prepared) {
  return {
    schemaVersion: 1 as const,
    manifestHash: prepared.manifestHash,
    catalogueHash: prepared.catalogue.hash,
    catalogueSnapshot: prepared.catalogueSnapshot,
    criteriaHash: prepared.criteria,
    policyHash: prepared.policySnapshot,
    threshold: prepared.policy.threshold,
    conceptThresholds: prepared.policy.conceptThresholds,
    precisionTarget: PRECISION_TARGET,
    datasets: prepared.datasets.map(({ kind, sha256, records }) => ({ kind, sha256, records })),
    plannedCalls: prepared.plannedCalls,
    repeats: 1,
    retries: 0,
  };
}
function baseReport(prepared: Prepared, budget: BudgetPreview): ProductionVerificationReport {
  return {
    schemaVersion: 1,
    outcome: "dry-run",
    plannedCalls: prepared.plannedCalls,
    maxCalls: MAX_CALLS,
    repeats: 1,
    retries: 0,
    precisionTarget: PRECISION_TARGET,
    budget,
    provenance: receiptFor(prepared),
    policyWritten: false,
  };
}
function aggregate(metrics: RealPromptMetrics): AggregateMetrics {
  return {
    prompts: metrics.prompts,
    attempts: metrics.attempts,
    overall: metrics.overall,
    perConcept: Object.fromEntries(
      Object.entries(metrics.perConcept).map(([id, value]) => {
        const { distinctPromptEvidence: _evidence, ...scores } = value;
        return [id, scores];
      }),
    ),
  };
}
function score(
  prepared: Prepared,
  fixtures: readonly Fixture[],
  observations: readonly RealPromptObservation[],
) {
  const selections: RealPromptSelections = Object.fromEntries(
    prepared.catalogue.concepts.map(({ id }) => [
      id,
      {
        enabled: true,
        variant: "production",
        threshold: prepared.policy.conceptThresholds?.[id] ?? prepared.policy.threshold,
      },
    ]),
  );
  const gold: RealPromptGold[] = fixtures.map((fixture) => ({
    id: fixture.id,
    split: "heldout",
    labels: Object.fromEntries(
      Object.entries(fixture.labels).map(([id, label]) => [
        id,
        { label, named: fixture.named.includes(id) },
      ]),
    ),
  }));
  const wanted = new Set(fixtures.map((fixture) => fixture.id));
  return aggregate(
    computeRealPromptMetrics(
      {
        split: "heldout",
        repeats: 1,
        concepts: prepared.catalogue.concepts.map(({ id }) => ({ id, variants: ["production"] })),
        gold,
        observations: observations.filter((observation) => wanted.has(observation.id)),
      },
      selections,
    ),
  );
}

function precisionPasses(metrics: AggregateMetrics): boolean {
  return metrics.overall.precision !== null && metrics.overall.precision >= PRECISION_TARGET;
}

function evaluate(prepared: Prepared, observations: readonly RealPromptObservation[]) {
  const fixtures = prepared.datasets.flatMap((set) => set.fixtures);
  const overall = score(prepared, fixtures, observations);
  const datasets = prepared.datasets.map((set) => ({
    kind: set.kind,
    metrics: score(prepared, set.fixtures, observations),
  }));
  const privateFixtures = prepared.datasets
    .filter((set) => set.kind === "private")
    .flatMap((set) => set.fixtures);
  const privateMetrics =
    privateFixtures.length > 0 ? score(prepared, privateFixtures, observations) : undefined;
  const synthetic = score(
    prepared,
    prepared.datasets.filter((set) => set.kind === "synthetic").flatMap((set) => set.fixtures),
    observations,
  );
  const passed =
    precisionPasses(overall) &&
    datasets.every((set) => precisionPasses(set.metrics)) &&
    (privateMetrics === undefined || precisionPasses(privateMetrics)) &&
    precisionPasses(synthetic) &&
    Object.values(synthetic.perConcept).every(
      (concept) => concept.tp + concept.fn > 0 && concept.recall !== null && concept.recall >= 0.5,
    );
  return {
    passed,
    metrics: {
      overall,
      datasets,
      ...(privateMetrics === undefined ? {} : { private: privateMetrics }),
      synthetic,
    },
  };
}

async function dispatch(
  prepared: Prepared,
  registry: ProductionRegistry,
  ledger: LedgerSession,
  output: string,
  matcher: typeof matchWithNativeClassifier,
): Promise<RealPromptObservation[]> {
  const observations: RealPromptObservation[] = [];
  for (const fixture of prepared.datasets.flatMap((set) => set.fixtures)) {
    const recordId = `production-${observations.length + 1}`;
    await ledger.reserve(recordId);
    let captured: ClassifierResult | undefined;
    let calls = 0;
    const wrapper: ProductionRegistry = {
      findOfType: registry.findOfType.bind(registry),
      getProviderAuthStatus: registry.getProviderAuthStatus.bind(registry),
      classify: async (model, context, options) => {
        check(++calls === 1, "Only one native classification is permitted per reservation.");
        captured = await registry.classify(model, context, options);
        return captured;
      },
    };
    try {
      const result = await matcher(
        wrapper,
        prepared.catalogue,
        fixture.prompt,
        prepared.policy.threshold,
        AbortSignal.timeout(30_000),
        prepared.policy.conceptThresholds,
      );
      check(
        calls === 1 && captured !== undefined && result.ok,
        "Invalid or incomplete native classifier response.",
      );
      observeUsage(captured.usage);
      const answers = captured.answers;
      const ids = prepared.catalogue.concepts.map((concept) => concept.id);
      check(
        record(answers) && Object.keys(answers).length === ids.length,
        "Incomplete native probability matrix.",
      );
      const probabilities = Object.fromEntries(
        ids.map((id) => {
          const answer = answers[id];
          check(
            answer?.type === "bool" &&
              Number.isFinite(answer.probability) &&
              answer.probability >= 0 &&
              answer.probability <= 1,
            "Invalid native probability.",
          );
          return [id, { production: answer.probability }];
        }),
      );
      const alreadyNamed = suppressAlreadyNamed(
        extractClassifierText(prepared.catalogue, fixture.prompt),
        prepared.catalogue,
      );
      const selected = selectMatches(result.value.matches, EMPTY_STATE, 0, alreadyNamed);
      // Metrics model thresholding plus runtime name suppression. Refuse unmodelled selector drops.
      check(
        selected.length ===
          result.value.matches.filter((match) => !alreadyNamed.has(match.concept.id)).length,
        "Selector decisions cannot be represented by the frozen scoring contract.",
      );
      const observation: RealPromptObservation = {
        id: fixture.id,
        split: "heldout",
        repeat: 0,
        probabilities,
        alreadyNamed: [...alreadyNamed],
      };
      await appendFile(
        join(output, "observations.jsonl"),
        `${JSON.stringify({ observation, native: captured, selected: selected.map((match) => match.concept.id) })}\n`,
        { mode: 0o600 },
      );
      await ledger.settleSuccess(recordId, captured.usage);
      observations.push(observation);
    } catch {
      const attempt = ledger.snapshot().attempts.find((item) => item.recordId === recordId);
      if (attempt?.status === "reserved") {
        await ledger.settleFailure(recordId);
      }
      // Keep native data private even when missing answers or usage aborts the run.
      await appendFile(
        join(output, "observations.jsonl"),
        `${JSON.stringify({ recordId, failed: true, native: captured })}\n`,
        { mode: 0o600 },
      );
      throw new Error(
        "Verification stopped at the first invalid response or local error; no retries or policy activation.",
      );
    }
  }
  return observations;
}

async function activatePolicy(
  options: ProductionVerificationOptions,
  prepared: Prepared,
  precision: number,
): Promise<void> {
  const current = await currentInputs(options);
  check(
    stableHash(current.catalogue) === prepared.catalogueSnapshot &&
      criteriaHash(current.catalogue) === prepared.criteria &&
      stableHash(current.policy) === prepared.policySnapshot,
    "Catalogue, criteria or policy changed during verification.",
  );
  const policy: Policy = {
    ...prepared.policy,
    measured: true,
    precisionTarget: PRECISION_TARGET,
    measuredDisplayedPrecision: precision,
    fixtureHash: prepared.manifestHash,
  };
  const temporary = `${POLICY_PATH}.${process.pid}.production.tmp`;
  await writeFile(temporary, `${JSON.stringify(policy, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, POLICY_PATH);
}

/** Explicit local, single-use verification. Dry runs perform reads only, including budget preview. */
export async function runProductionVerification(
  options: ProductionVerificationOptions,
): Promise<ProductionVerificationReport> {
  const agentDir = options.agentDir ?? getAgentDir();
  const productionDir = join(agentDir, "pi-terminology", "production-verification");
  const ledgerPath = join(productionDir, "eval-ledger.json");
  const receiptPath = join(productionDir, "receipt.json");
  const output = resolve(options.output);
  await requireAbsent(output, "Output directory already exists; refusing.");
  await requireAbsent(receiptPath, "Production verification receipt has already been consumed.");
  const prepared = await prepare(options);
  const preview = previewBudget(await readLedger(ledgerPath), MAX_CALLS);
  check(preview.fits, "All 360 full reservations must fit the existing $1 production budget.");
  if (options.dryRun === true) {
    return baseReport(prepared, preview);
  }

  await mkdir(productionDir, { recursive: true, mode: 0o700 });
  const ledger = await openLedger(ledgerPath);
  try {
    await requireAbsent(receiptPath, "Production verification receipt has already been consumed.");
    const frozen = await prepare(options);
    check(
      stableHash(receiptFor(frozen)) === stableHash(receiptFor(prepared)),
      "Inputs changed before freeze.",
    );
    const budget = previewBudget(ledger.snapshot(), MAX_CALLS);
    check(budget.fits, "All 360 full reservations must fit the existing $1 production budget.");
    await mkdir(output, { mode: 0o700 });
    await writeFile(receiptPath, `${JSON.stringify(receiptFor(frozen), null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(
      join(output, "receipt.json"),
      `${JSON.stringify(receiptFor(frozen), null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    let report = baseReport(frozen, budget);
    try {
      const registry = await (
        options.createRegistry ?? (async () => createNativeRegistry(agentDir))
      )();
      check(
        registry.getProviderAuthStatus("typesafe").configured,
        "Typesafe credentials are not configured.",
      );
      const observations = await dispatch(
        frozen,
        registry,
        ledger,
        output,
        options.matcher ?? matchWithNativeClassifier,
      );
      const evaluated = evaluate(frozen, observations);
      report = {
        ...report,
        outcome: evaluated.passed ? "passed" : "failed",
        metrics: evaluated.metrics,
      };
    } catch {
      report = {
        ...report,
        outcome: "error",
        error: "Verification aborted; receipt consumed. No retries or policy activation.",
      };
    }
    const snapshot = ledger.snapshot();
    report = {
      ...report,
      ledger: {
        ...budgetTotals(snapshot),
        inputTokens: snapshot.attempts.reduce(
          (sum, attempt) => sum + (attempt.inputTokens ?? 0),
          0,
        ),
        outputTokens: snapshot.attempts.reduce(
          (sum, attempt) => sum + (attempt.outputTokens ?? 0),
          0,
        ),
        nativeCostUsd: snapshot.attempts.every((attempt) => attempt.nativeCostUsd !== null)
          ? snapshot.attempts.reduce((sum, attempt) => sum + (attempt.nativeCostUsd ?? 0), 0)
          : null,
      },
    };
    const shouldActivate = report.outcome === "passed" && options.writePolicy === true;
    report = { ...report, policyWritten: shouldActivate };
    // Persist all evidence before the final policy rename. A local evidence-write failure must
    // never leave automatic reminders activated. If activation itself fails, correct the report.
    const reportPath = join(output, "report.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    if (shouldActivate) {
      try {
        await activatePolicy(options, frozen, report.metrics?.overall.overall.precision ?? 0);
      } catch {
        report = {
          ...report,
          outcome: "error",
          policyWritten: false,
          error: "Policy activation refused; frozen inputs changed or a local write failed.",
        };
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      }
    }
    return report;
  } finally {
    await ledger.close();
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      manifest: { type: "string" },
      output: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "write-policy": { type: "boolean", default: false },
    },
  });
  check(
    text(values.manifest) && text(values.output),
    "Usage: verify-production.ts --manifest PATH --output NEW_PATH [--dry-run] [--write-policy]",
  );
  const report = await runProductionVerification({
    manifest: values.manifest,
    output: values.output,
    dryRun: values["dry-run"],
    writePolicy: values["write-policy"],
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.outcome === "failed" || report.outcome === "error") {
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    process.stderr.write(
      "Production verification refused or aborted. Check local inputs, receipt and budget; no automatic retry.\n",
    );
    process.exitCode = 1;
  });
}
