/* oxlint-disable no-await-in-loop -- Sequential reservations and stop-on-first-error are deliberate budget invariants. */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { criteriaHash, loadCatalogue } from "../catalogue";
import { extractClassifierText } from "../classifier-request";
import { budgetTotals, openLedger, previewBudget, readLedger } from "../eval-budget";
import type { LedgerSession } from "../eval-budget";
import { matchWithNativeClassifier } from "../native-matcher";
import { computeRealPromptMetrics } from "../real-prompt-metrics";
import type { RealPromptDataset, RealPromptObservation } from "../real-prompt-metrics";
import { selectMatches, suppressAlreadyNamed } from "../selection";
import type { Catalogue, Policy } from "../types";
import { stableHash } from "../validation";
import { createNativeRegistry } from "./evaluate";
import type { EvalRegistry, Matcher } from "./evaluate";
import type { ExpansionFixture, ExpansionManifest } from "./evaluate-expansion";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(homedir(), ".pi/agent/pi-terminology/expansion-2026-10-22");
const PINS = {
  "manifest.json": "38540f82fcb42bcb9b2cde16cba4ac41e987d3d16fd2b6a24f3073ae7f6f833b",
  "verify-receipt.json": "35b4877934a0fc3867de9a705854d32135f1f7ff78b1e56d27b3b14b16bf3188",
  "freeze.json": "3645ef7055df76ac69c8339fcf3078721f5bdf45c50cc89735390c5b7e3cd24b",
};
const EMPTY = {
  hiddenConceptIds: new Set<string>(),
  dismissedConceptIds: new Set<string>(),
  cooldowns: new Map<string, number>(),
};
type Row = ExpansionFixture & { kind: "private" | "synthetic" };
type Frozen = {
  binding: {
    manifest: string;
    catalogue: string;
    criteria: string;
    baseline: string;
    sources: Record<string, string>;
  };
  thresholds: Record<string, number>;
  tuningReport: string;
  tuningObservations: string;
  developmentPrompts: string[];
  ledgerHash: string;
};
type Sample = {
  observation: RealPromptObservation;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
};
type Dependencies = NonNullable<Parameters<typeof runExpansionDiagnostic>[1]>;
function check(value: boolean, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
async function hash(path: string) {
  return sha(await readFile(path));
}
async function json<T>(path: string): Promise<T> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Committed JSON boundary; integrity and metric matrix validation follow.
  return JSON.parse(await readFile(path, "utf8")) as T;
}
async function save(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
function normalized(prompt: string) {
  return sha(prompt.normalize("NFKC").replaceAll(/\s+/gu, " ").trim().toLowerCase());
}
function validNamed(row: ExpansionFixture, ids: string[]) {
  check(
    Array.isArray(row.named) &&
      new Set(row.named).size === row.named.length &&
      row.named.every((id) => ids.includes(id) && row.labels[id] === "positive"),
    "Named concepts must be positive.",
  );
}
function validRow(row: ExpansionFixture, ids: string[]) {
  check(
    typeof row.id === "string" &&
      row.id.length > 0 &&
      typeof row.prompt === "string" &&
      row.prompt.trim().length > 0 &&
      row.prompt.length <= 60_000,
    "Invalid fixture.",
  );
  check(
    typeof row.labels === "object" &&
      row.labels !== null &&
      Object.keys(row.labels).length === ids.length &&
      ids.every((id) => ["positive", "negative", "ambiguous"].includes(row.labels[id] ?? "")),
    "Incomplete label matrix.",
  );
  validNamed(row, ids);
}
async function loadRows(
  root: string,
  entries: ExpansionManifest["development"],
  catalogue: Catalogue,
) {
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const path = resolve(root, entry.file);
    check(entry.kind === "synthetic" || entry.kind === "private", "Invalid dataset kind.");
    check((await hash(path)) === entry.sha256, "Fixture commitment mismatch.");
    const values = await json<ExpansionFixture[]>(path);
    check(
      Array.isArray(values) && values.length === entry.records,
      "Fixture record count mismatch.",
    );
    for (const row of values) {
      validRow(
        row,
        catalogue.concepts.map((c) => c.id),
      );
      check(!seen.has(row.id), "Duplicate fixture ID.");
      seen.add(row.id);
      rows.push({ ...row, kind: entry.kind });
    }
  }
  return rows;
}
function deduplicate(rows: Row[], dev: string[]) {
  const kept = new Map<string, Row>();
  const aliases = new Map<string, string>();
  for (const row of rows) {
    const key = normalized(row.prompt);
    check(!dev.includes(key), "Heldout overlaps development.");
    const existing = kept.get(key);
    if (existing === undefined) {
      kept.set(key, { ...row, labels: { ...row.labels }, named: [...row.named] });
      continue;
    }
    check(existing.kind === row.kind, "Cross-kind duplicate cannot be safely fused.");
    aliases.set(row.id, existing.id);
    for (const id of Object.keys(existing.labels)) {
      if (existing.labels[id] !== row.labels[id]) {
        existing.labels[id] = "ambiguous";
      }
    }
    existing.named = [...new Set([...existing.named, ...row.named])].filter(
      (id) => existing.labels[id] === "positive",
    );
  }
  return { rows: [...kept.values()], aliases, excluded: rows.length - kept.size };
}
async function tuningProvenance(root: string, frozen: Frozen) {
  const ledger = await readLedger(join(root, "eval-ledger.json"));
  check(
    ledger.attempts.length === 120 &&
      ledger.attempts.every((a) => a.status === "succeeded" && a.recordId.startsWith("tune/")) &&
      stableHash(ledger) === frozen.ledgerHash,
    "Requires exactly 120 completed tuning calls and zero heldout calls.",
  );
  const manifest = await json<ExpansionManifest>(join(root, "manifest.json"));
  check(
    (await hash(join(root, "manifest.json"))) === frozen.binding.manifest,
    "Original manifest changed.",
  );
  check(
    (await hash(join(root, "tuning-report.json"))) === frozen.tuningReport &&
      (await hash(join(root, "tuning-observations.json"))) === frozen.tuningObservations,
    "Tuning artifacts changed.",
  );
  const seal = await json<{
    reportHash: string;
    observationsHash: string;
    originalObservations: string;
    originalHash: string;
    ledgerHash: string;
  }>(join(root, "tuning-completion.json"));
  check(
    seal.reportHash === frozen.tuningReport &&
      seal.observationsHash === frozen.tuningObservations &&
      seal.ledgerHash === frozen.ledgerHash &&
      resolve(seal.originalObservations).startsWith(`${resolve(root)}/`) &&
      (await hash(seal.originalObservations)) === seal.originalHash,
    "Tuning completion seal changed.",
  );
  const originalText = await readFile(seal.originalObservations, "utf8");
  check(
    stableHash(
      originalText
        .trim()
        .split("\n")
        .map((line): unknown => JSON.parse(line)),
    ) === stableHash(await json<unknown>(join(root, "tuning-observations.json"))),
    "Original native log mismatch.",
  );
  return { ledger, manifest, seal };
}
function validateDiagnosticPlan(
  raw: Row[],
  dedup: ReturnType<typeof deduplicate>,
  manifest: ExpansionManifest,
  frozen: Frozen,
  catalogue: Catalogue,
  baseline: Policy,
) {
  check(
    raw.filter((r) => r.kind === "synthetic").length === 148 &&
      raw.filter((r) => r.kind === "private").length === 80 &&
      dedup.excluded === 1,
    "Only the known single duplicate exclusion is authorized.",
  );
  check(
    Array.isArray(manifest.repeats) &&
      manifest.repeats.length === 12 &&
      new Set(manifest.repeats).size === 12 &&
      manifest.repeats.every((id) => raw.some((r) => r.id === id)),
    "Original twelve repeat commitments required.",
  );
  check(
    Object.keys(frozen.thresholds).length === 51 &&
      catalogue.concepts.every(
        (c) =>
          Number.isFinite(frozen.thresholds[c.id]) &&
          (frozen.thresholds[c.id] ?? 0) > 0 &&
          (frozen.thresholds[c.id] ?? 2) <= 1,
      ),
    "Invalid frozen thresholds.",
  );
  check(
    baseline.conceptThresholds !== undefined &&
      Object.keys(baseline.conceptThresholds).length === 10,
    "Archived ten-concept baseline required.",
  );
}
async function validateFrozenIdentity(
  catalogue: Catalogue,
  baseline: Policy,
  frozen: Frozen,
  policyPath: string,
) {
  const policy = await json<Policy>(policyPath);
  check(!policy.measured, "Policy must remain unmeasured.");
  check(
    catalogue.concepts.length === 51 &&
      catalogue.recognition.length === 51 &&
      stableHash(catalogue) === frozen.binding.catalogue &&
      criteriaHash(catalogue) === frozen.binding.criteria &&
      stableHash(baseline) === frozen.binding.baseline,
    "Frozen catalogue or baseline mismatch.",
  );
}
async function pinnedPreflight(root: string, pins: Record<string, string>) {
  for (const [file, digest] of Object.entries(pins)) {
    check((await hash(join(root, file))) === digest, "Pinned preflight evidence changed.");
  }
  const verifyFiles = await readdir(join(root, "verify"));
  check(verifyFiles.length === 0, "Original verify output is not empty.");
  const frozen = await json<Frozen>(join(root, "freeze.json"));
  check(Object.keys(frozen.binding.sources).length === 18, "Expected eighteen frozen sources.");
  for (const [file, digest] of Object.entries(frozen.binding.sources)) {
    check((await hash(resolve(PACKAGE, file))) === digest, "Frozen source changed.");
  }
  return frozen;
}
function diagnosticBudget(ledger: Awaited<ReturnType<typeof readLedger>>, planned: number) {
  check(
    120 + planned <= 360 &&
      previewBudget(ledger, planned).fits &&
      previewBudget(ledger, planned).projectedOverallNanos <= 1_000_000_000,
    "Shared full-reservation budget exceeded.",
  );
}
async function prepare(deps: Dependencies) {
  const root = deps.root ?? ROOT;
  const pins = deps.pins ?? PINS;
  const frozen = await pinnedPreflight(root, pins);
  const catalogue = deps.catalogue ?? loadCatalogue().catalogue;
  const baseline =
    deps.baseline ?? (await json<Policy>(join(PACKAGE, "evals/production/policy.json")));
  const policyPath = join(PACKAGE, "glossary/policy.json");
  await validateFrozenIdentity(catalogue, baseline, frozen, policyPath);
  const { ledger, manifest, seal } = await tuningProvenance(root, frozen);
  const dev = await loadRows(root, manifest.development, catalogue);
  check(
    dev.length === 120 &&
      stableHash(dev.map((r) => normalized(r.prompt))) === stableHash(frozen.developmentPrompts),
    "Development commitment mismatch.",
  );
  const raw = await loadRows(root, manifest.heldout, catalogue);
  const dedup = deduplicate(raw, frozen.developmentPrompts);
  validateDiagnosticPlan(raw, dedup, manifest, frozen, catalogue, baseline);
  const planned = dedup.rows.length + (manifest.repeats?.length ?? 0);
  diagnosticBudget(ledger, planned);
  const evidence = {
    pins,
    sources: frozen.binding.sources,
    tuningSeal: await hash(join(root, "tuning-completion.json")),
    nativeLog: { path: seal.originalObservations, sha256: seal.originalHash },
    policy: await hash(policyPath),
    script: await hash(fileURLToPath(import.meta.url)),
    fixtureHashes: [...manifest.development, ...manifest.heldout].map((e) => [
      resolve(root, e.file),
      e.sha256,
    ]),
  };
  return {
    root,
    frozen,
    catalogue,
    baseline,
    ledger,
    manifest,
    ...dedup,
    planned,
    evidence,
    policyPath,
  };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;
async function recheck(p: Prepared) {
  check(
    stableHash(p.catalogue) === p.frozen.binding.catalogue &&
      stableHash(p.baseline) === p.frozen.binding.baseline,
    "Catalogue or baseline mutated.",
  );
  check(
    (await hash(p.evidence.nativeLog.path)) === p.evidence.nativeLog.sha256,
    "Original native log mutated.",
  );
  const verifyFiles = await readdir(join(p.root, "verify"));
  check(verifyFiles.length === 0, "Original verify output mutated.");
  for (const [file, digest] of Object.entries(p.evidence.pins)) {
    check((await hash(join(p.root, file))) === digest, "Preflight evidence mutated.");
  }
  for (const [file, digest] of Object.entries(p.evidence.sources)) {
    check((await hash(resolve(PACKAGE, file))) === digest, "Source mutated.");
  }
  for (const [path, digest] of p.evidence.fixtureHashes) {
    check(typeof path === "string" && (await hash(path)) === digest, "Fixtures mutated.");
  }
  check(
    (await hash(p.policyPath)) === p.evidence.policy &&
      (await hash(join(p.root, "tuning-completion.json"))) === p.evidence.tuningSeal &&
      (await hash(fileURLToPath(import.meta.url))) === p.evidence.script,
    "Policy or diagnostic evidence mutated.",
  );
  check(
    (await hash(join(p.root, "tuning-report.json"))) === p.frozen.tuningReport &&
      (await hash(join(p.root, "tuning-observations.json"))) === p.frozen.tuningObservations,
    "Tuning artifacts mutated.",
  );
}
async function call(
  p: Prepared,
  deps: Dependencies,
  registry: EvalRegistry,
  ledger: LedgerSession,
  row: Row,
  repeat: number,
): Promise<Sample> {
  const key = `diagnostic/${row.id}/${repeat}`;
  check(ledger.snapshot().attempts.length < 360, "Attempt ceiling.");
  await ledger.reserve(key);
  const started = performance.now();
  let settled = false;
  try {
    const result = await (deps.matcher ?? matchWithNativeClassifier)(
      registry,
      p.catalogue,
      row.prompt,
      0,
      AbortSignal.timeout(5000),
    );
    check(result.ok, "Native classifier failed.");
    const matches = result.value.matches;
    check(
      matches.length === 51 &&
        new Set(matches.map((m) => m.concept.id)).size === 51 &&
        matches.every(
          (m) =>
            p.catalogue.concepts.some((c) => c.id === m.concept.id) &&
            Number.isFinite(m.probability) &&
            m.probability >= 0 &&
            m.probability <= 1,
        ),
      "Incomplete native result.",
    );
    settled = true;
    const usage = await ledger.settleSuccess(key, result.value.usage);
    const named = suppressAlreadyNamed(extractClassifierText(p.catalogue, row.prompt), p.catalogue);
    check(
      selectMatches(matches, EMPTY, 0, named).length ===
        matches.filter((m) => !named.has(m.concept.id)).length,
      "Unmodelled selector drop.",
    );
    return {
      observation: {
        id: row.id,
        split: "heldout",
        repeat,
        alreadyNamed: [...named],
        probabilities: Object.fromEntries(
          matches.map((m) => [m.concept.id, { native: m.probability }]),
        ),
      },
      latencyMs: Math.round(performance.now() - started),
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    };
  } catch {
    if (!settled) {
      await ledger.settleFailure(key);
    }
    await appendFile(
      join(p.root, "diagnostic/failures.jsonl"),
      `${JSON.stringify({ latencyMs: Math.round(performance.now() - started), inputTokens: null, outputTokens: null })}\n`,
      { mode: 0o600 },
    );
    throw new Error("Native attempt failed; no retry permitted.");
  }
}
function metrics(
  p: Prepared,
  samples: Sample[],
  thresholds: Record<string, number>,
  kind?: Row["kind"],
) {
  const rows = p.rows.filter((r) => kind === undefined || r.kind === kind);
  const data: RealPromptDataset = {
    split: "heldout",
    repeats: 1,
    concepts: p.catalogue.concepts.map((c) => ({ id: c.id, variants: ["native"] })),
    gold: rows.map((r) => ({
      id: r.id,
      split: "heldout",
      labels: Object.fromEntries(
        Object.entries(r.labels).map(([id, label]) => [id, { label, named: r.named.includes(id) }]),
      ),
    })),
    observations: samples
      .filter((s) => s.observation.repeat === 0 && rows.some((r) => r.id === s.observation.id))
      .map((s) => s.observation),
  };
  return computeRealPromptMetrics(
    data,
    Object.fromEntries(
      Object.entries(thresholds).map(([id, threshold]) => [
        id,
        { enabled: true, variant: "native", threshold },
      ]),
    ),
  );
}
function selected(s: Sample, cutoffs: Record<string, number>) {
  return Object.entries(cutoffs)
    .filter(
      ([id, cutoff]) =>
        !s.observation.alreadyNamed.includes(id) &&
        (s.observation.probabilities[id]?.native ?? 0) >= cutoff,
    )
    .map(([id]) => id)
    .toSorted();
}
function useful(p: Prepared, samples: Sample[], cutoffs: Record<string, number>) {
  return p.rows.filter(
    (r) =>
      r.kind === "private" &&
      samples.some(
        (s) =>
          s.observation.repeat === 0 &&
          s.observation.id === r.id &&
          selected(s, cutoffs).some((id) => r.labels[id] === "positive" && !r.named.includes(id)),
      ),
  ).length;
}
function scoredReport(p: Prepared, samples: Sample[]) {
  const overall = metrics(p, samples, p.frozen.thresholds);
  const privateMetrics = metrics(p, samples, p.frozen.thresholds, "private");
  const synthetic = metrics(p, samples, p.frozen.thresholds, "synthetic");
  const old = p.baseline.conceptThresholds ?? {};
  const thresholds = Object.fromEntries(p.catalogue.concepts.map((c) => [c.id, old[c.id] ?? 1]));
  const baselineSamples = samples.map((s) => ({
    ...s,
    observation: {
      ...s.observation,
      alreadyNamed: [
        ...new Set([
          ...s.observation.alreadyNamed,
          ...p.catalogue.concepts.filter((c) => !Object.hasOwn(old, c.id)).map((c) => c.id),
        ]),
      ],
    },
  }));
  const probes = samples
    .filter((s) => s.observation.repeat > 0)
    .map((s) => {
      const original = samples.find(
        (x) => x.observation.id === s.observation.id && x.observation.repeat === 0,
      );
      check(original !== undefined, "Missing original probe.");
      return {
        agreement:
          stableHash(selected(original, p.frozen.thresholds)) ===
          stableHash(selected(s, p.frozen.thresholds)),
        delta: Math.max(
          ...p.catalogue.concepts.map((c) =>
            Math.abs(
              (s.observation.probabilities[c.id]?.native ?? 0) -
                (original.observation.probabilities[c.id]?.native ?? 0),
            ),
          ),
        ),
      };
    });
  return {
    metrics: { overall, private: privateMetrics, synthetic },
    baseline: metrics(p, baselineSamples, thresholds),
    baselineNote:
      "Observational old-ten subset on the same 51-question probabilities; not causal, not clean acceptance.",
    usefulPrivatePromptGain:
      useful(p, samples, p.frozen.thresholds) - useful(p, baselineSamples, old),
    precisionGates: [overall, privateMetrics, synthetic].map(
      (m) => (m.overall.precision ?? 0) >= 0.9,
    ),
    syntheticRecallGate: Object.values(synthetic.perConcept).every(
      (m) => m.distinctUnnamedPositivePrompts > 0 && (m.recall ?? 0) >= 0.5,
    ),
    repeatStability: {
      probes: probes.length,
      selectedSetAgreements: probes.filter((r) => r.agreement).length,
      maximumProbabilityDelta: Math.max(0, ...probes.map((r) => r.delta)),
    },
  };
}
async function collectDiagnostic(p: Prepared, deps: Dependencies, ledger: LedgerSession) {
  const samples: Sample[] = [];
  const errors: string[] = [];
  try {
    await recheck(p);
    const registry = await (
      deps.createRegistry ?? (async () => createNativeRegistry(join(homedir(), ".pi/agent")))
    )();
    check(registry.getProviderAuthStatus("typesafe").configured, "Missing native credentials.");
    const repeats = p.manifest.repeats ?? [];
    const steps = [
      ...p.rows.map((row) => ({ row, repeat: 0 })),
      ...repeats.map((id) => {
        const row = p.rows.find((r) => r.id === (p.aliases.get(id) ?? id));
        check(row !== undefined, "Missing committed probe.");
        return { row, repeat: 1 };
      }),
    ];
    for (const step of steps) {
      const sample = await call(p, deps, registry, ledger, step.row, step.repeat);
      samples.push(sample);
      await appendFile(
        join(p.root, "diagnostic/observations.jsonl"),
        `${JSON.stringify(sample)}\n`,
        { mode: 0o600 },
      );
    }
    await recheck(p);
  } catch {
    errors.push(
      "Diagnostic incomplete or integrity check failed; original acceptance remains blocked.",
    );
  }
  return { samples, errors };
}
async function failureRecords(root: string) {
  const failures: { latencyMs: number }[] = [];
  try {
    const text = await readFile(join(root, "diagnostic/failures.jsonl"), "utf8");
    for (const line of text.trim().split("\n")) {
      const parsed: unknown = JSON.parse(line);
      check(
        typeof parsed === "object" &&
          parsed !== null &&
          "latencyMs" in parsed &&
          typeof parsed.latencyMs === "number" &&
          Number.isFinite(parsed.latencyMs) &&
          parsed.latencyMs >= 0,
        "Invalid diagnostic failure record.",
      );
      failures.push({ latencyMs: parsed.latencyMs });
    }
  } catch {
    /* No dispatched failure, e.g. auth failure. */
  }
  return failures;
}
/** Explicitly non-promoting recovery diagnostic; test dependencies are never exposed through CLI. */
export async function runExpansionDiagnostic(
  dryRun = false,
  deps: {
    root?: string;
    catalogue?: Catalogue;
    baseline?: Policy;
    createRegistry?: () => Promise<EvalRegistry>;
    matcher?: Matcher;
    /** Test-only fixture commitments; CLI never accepts overrides. */ pins?: Record<
      string,
      string
    >;
  } = {},
): Promise<Record<string, unknown>> {
  const p = await prepare(deps);
  if (dryRun) {
    return {
      outcome: "diagnostic-only",
      dryRun: true,
      plannedAttempts: p.planned,
      duplicatesExcluded: p.excluded,
      budget: previewBudget(p.ledger, p.planned),
      originalAcceptanceBlocked: true,
    };
  }
  const ledger = await openLedger(join(p.root, "eval-ledger.json"));
  try {
    check(stableHash(ledger.snapshot()) === stableHash(p.ledger), "Ledger changed.");
    await mkdir(join(p.root, "diagnostic"), { mode: 0o700 });
    await save(join(p.root, "diagnostic-receipt.json"), {
      evidence: p.evidence,
      frozenThresholdHash: stableHash(p.frozen.thresholds),
      plannedAttempts: p.planned,
      originalAcceptanceBlocked: true,
    });
    const { samples, errors } = await collectDiagnostic(p, deps, ledger);
    const failures = await failureRecords(p.root);
    const complete = errors.length === 0 && samples.length === p.planned;
    const total = samples.length + failures.length;
    const report = {
      outcome: "diagnostic-only",
      originalAcceptanceBlocked: true,
      policyWritten: false,
      complete,
      errors,
      duplicatesExcluded: p.excluded,
      plannedAttempts: p.planned,
      completedAttempts: samples.length,
      binding: p.frozen.binding,
      frozenThresholdHash: stableHash(p.frozen.thresholds),
      budget: budgetTotals(ledger.snapshot()),
      tokens: {
        input: samples.reduce((n, s) => n + s.inputTokens, 0),
        output: samples.reduce((n, s) => n + s.outputTokens, 0),
      },
      latency: {
        dispatchedAttempts: total,
        failedAttempts: failures.length,
        elapsedMs: [...samples.map((s) => s.latencyMs), ...failures.map((f) => f.latencyMs)],
        completedWithin5sRate:
          total > 0 ? samples.filter((s) => s.latencyMs <= 5000).length / total : null,
      },
      ...(complete ? scoredReport(p, samples) : {}),
      policyUnchanged: (await hash(p.policyPath)) === p.evidence.policy,
    };
    await save(join(p.root, "diagnostic/report.json"), report);
    return report;
  } finally {
    await ledger.close();
  }
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    check(
      process.argv.slice(2).every((arg) => arg === "--dry-run") && process.argv.length <= 3,
      "Only --dry-run is accepted.",
    );
    const report = await runExpansionDiagnostic(process.argv.includes("--dry-run"));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.complete === false ? 1 : 0;
  } catch {
    process.stderr.write(
      "Diagnostic refused or incomplete; original acceptance remains blocked.\n",
    );
    process.exitCode = 1;
  }
}
