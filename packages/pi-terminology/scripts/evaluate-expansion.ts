/* oxlint-disable no-await-in-loop -- Serial dispatch is a deliberate no-retry budget invariant; dataset reads also fail closed in order. */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { criteriaHash, loadCatalogue } from "../catalogue";
import { extractClassifierText } from "../classifier-request";
import { budgetTotals, openLedger, previewBudget, readLedger } from "../eval-budget";
import type { LedgerSession } from "../eval-budget";
import { JEV_MODEL_ID, matchWithNativeClassifier } from "../native-matcher";
import { computeRealPromptMetrics } from "../real-prompt-metrics";
import type {
  RealPromptDataset,
  RealPromptGold,
  RealPromptMetrics,
  RealPromptObservation,
  RealPromptSelections,
} from "../real-prompt-metrics";
import { selectMatches, suppressAlreadyNamed } from "../selection";
import type { Catalogue, Policy } from "../types";
import { stableHash } from "../validation";
import { createNativeRegistry } from "./evaluate";
import type { EvalRegistry, Matcher } from "./evaluate";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXPANSION_RUN = join(homedir(), ".pi/agent/pi-terminology/expansion-2026-10-22");
const EMPTY = {
  hiddenConceptIds: new Set<string>(),
  dismissedConceptIds: new Set<string>(),
  cooldowns: new Map<string, number>(),
};
const SOURCE_FILES = [
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
  "glossary/core.json",
  "glossary/policy.json",
  "evals/production/core.json",
  "evals/production/policy.json",
];
export type ExpansionManifest = {
  schemaVersion: 1;
  development: {
    name: string;
    kind: "synthetic" | "private";
    file: string;
    sha256: string;
    records: number;
  }[];
  heldout: ExpansionManifest["development"];
  repeats?: string[];
};
type Entry = ExpansionManifest["development"][number];
export type ExpansionFixture = {
  id: string;
  prompt: string;
  labels: Record<string, "positive" | "negative" | "ambiguous">;
  named: string[];
  group?: string;
};
type Fixture = ExpansionFixture & { kind: Entry["kind"]; group: string };
type Observation = {
  observation: RealPromptObservation;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
};
type Binding = {
  manifest: string;
  catalogue: string;
  criteria: string;
  baseline: string;
  sources: Record<string, string>;
};
type Frozen = {
  binding: Binding;
  thresholds: Record<string, number>;
  tuningReport: string;
  tuningObservations: string;
  developmentPrompts: string[];
  ledgerHash: string;
};
export type ExpansionOptions = {
  phase: "tune" | "freeze" | "verify";
  manifest: string;
  output: string;
  dryRun?: boolean;
  writePolicy?: boolean;
  /** Test dependency boundaries, deliberately not exposed as CLI overrides. */
  runDir?: string;
  catalogue?: Catalogue;
  baseline?: Policy;
  policyPath?: string;
  createRegistry?: () => Promise<EvalRegistry>;
  matcher?: Matcher;
};
function required<T>(value: T | undefined): T {
  check(value !== undefined, "Missing validated value.");
  return value;
}
function check(value: unknown, message: string): asserts value {
  if (value === false || value === undefined || value === null || value === "") {
    throw new Error(message);
  }
}
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const readJson = async <T>(path: string): Promise<T> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Committed JSON boundary; callers validate shape, hashes and complete metric matrices.
  JSON.parse(await readFile(path, "utf8")) as T;
async function writeNew(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
async function hashFile(path: string) {
  return sha(await readFile(path));
}
function promptHash(prompt: string) {
  return sha(prompt.normalize("NFKC").replaceAll(/\s+/gu, " ").trim().toLowerCase());
}
function entries(value: unknown, cap: number): asserts value is Entry[] {
  check(Array.isArray(value) && value.length > 0, "Missing split commitments.");
  const names = new Set<string>();
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Every commitment field is checked in this loop before use.
  for (const e of value as Entry[]) {
    check(
      typeof e === "object" &&
        e !== null &&
        typeof e.name === "string" &&
        !names.has(e.name) &&
        (e.kind === "synthetic" || e.kind === "private") &&
        typeof e.file === "string" &&
        /^[a-f0-9]{64}$/u.test(e.sha256) &&
        Number.isSafeInteger(e.records) &&
        e.records > 0,
      "Invalid dataset commitment.",
    );
    names.add(e.name);
  }
  check(
    value.reduce((n: number, e: Entry): number => n + e.records, 0) <= cap,
    "Split exceeds protocol prompt cap.",
  );
}
async function manifestAt(path: string): Promise<ExpansionManifest> {
  const m = await readJson<ExpansionManifest>(path);
  check(m.schemaVersion === 1, "Invalid manifest version.");
  entries(m.development, 120);
  entries(m.heldout, 228);
  check(
    m.heldout.filter((e) => e.kind === "synthetic").reduce((n, e) => n + e.records, 0) <= 148 &&
      m.heldout.filter((e) => e.kind === "private").reduce((n, e) => n + e.records, 0) <= 80,
    "Heldout kind caps are 148 synthetic and 80 private.",
  );
  check(
    m.heldout.some((e) => e.kind === "private") && m.heldout.some((e) => e.kind === "synthetic"),
    "Heldout requires private and synthetic commitments.",
  );
  check(
    m.repeats === undefined ||
      (Array.isArray(m.repeats) &&
        m.repeats.length <= 12 &&
        m.repeats.every((id) => typeof id === "string") &&
        new Set(m.repeats).size === m.repeats.length),
    "Invalid repeat plan (at most 12 unique IDs).",
  );
  return m;
}
async function fixturesAt(path: string, split: Entry[], catalogue: Catalogue): Promise<Fixture[]> {
  const fixtures: Fixture[] = [];
  const ids = catalogue.concepts.map((c) => c.id);
  const seen = new Set<string>();
  const prompts = new Set<string>();
  for (const e of split) {
    const bytes = await readFile(resolve(dirname(path), e.file));
    check(sha(bytes) === e.sha256, "Dataset SHA-256 mismatch.");
    const rows: unknown = JSON.parse(bytes.toString("utf8"));
    check(Array.isArray(rows) && rows.length === e.records, "Dataset record count mismatch.");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Every fixture field is checked in this loop before use.
    for (const f of rows as ExpansionFixture[]) {
      check(
        typeof f === "object" &&
          f !== null &&
          typeof f.id === "string" &&
          f.id.length > 0 &&
          !seen.has(f.id) &&
          typeof f.prompt === "string" &&
          f.prompt.trim().length > 0 &&
          f.prompt.length <= 60_000,
        "Invalid or duplicate fixture.",
      );
      check(
        typeof f.labels === "object" &&
          f.labels !== null &&
          Object.keys(f.labels).length === ids.length &&
          ids.every((id) => ["positive", "negative", "ambiguous"].includes(f.labels[id] ?? "")),
        "Full-matrix labels required.",
      );
      check(
        Array.isArray(f.named) &&
          new Set(f.named).size === f.named.length &&
          f.named.every((id) => ids.includes(id)),
        "Invalid named labels.",
      );
      check(f.group === undefined || typeof f.group === "string", "Invalid prompt group.");
      check(!prompts.has(promptHash(f.prompt)), "Duplicate normalized prompt.");
      seen.add(f.id);
      prompts.add(promptHash(f.prompt));
      fixtures.push({ ...f, kind: e.kind, group: f.group ?? e.name });
    }
  }
  return fixtures;
}
async function bindingAt(
  o: ExpansionOptions,
  catalogue: Catalogue,
  baseline: Policy,
): Promise<Binding> {
  return {
    manifest: await hashFile(o.manifest),
    catalogue: stableHash(catalogue),
    criteria: criteriaHash(catalogue),
    baseline: stableHash(baseline),
    sources: Object.fromEntries<string>(
      await Promise.all(
        SOURCE_FILES.map(async (f): Promise<readonly [string, string]> => [
          f,
          await hashFile(join(PACKAGE, f)),
        ]),
      ),
    ),
  };
}
function dataset(
  fixtures: Fixture[],
  observations: Observation[],
  catalogue: Catalogue,
  split: "tuning" | "heldout",
): RealPromptDataset {
  const wanted = new Set(fixtures.map((f) => f.id));
  return {
    split,
    repeats: 1,
    concepts: catalogue.concepts.map((c) => ({ id: c.id, variants: ["native"] })),
    gold: fixtures.map((f): RealPromptGold => ({
      id: f.id,
      split,
      labels: Object.fromEntries(
        Object.entries(f.labels).map(([id, label]) => [id, { label, named: f.named.includes(id) }]),
      ),
    })),
    observations: observations
      .filter((r) => r.observation.repeat === 0 && wanted.has(r.observation.id))
      .map((r) => r.observation),
  };
}
function selections(thresholds: Record<string, number>): RealPromptSelections {
  return Object.fromEntries(
    Object.entries(thresholds).map(([id, threshold]) => [
      id,
      { enabled: true, variant: "native", threshold },
    ]),
  );
}
type TuningCandidate = { threshold: number; recall: number; precision: number };
function qualifiesForTuning(
  m: RealPromptMetrics["perConcept"][string] | undefined,
  positives: number,
): m is RealPromptMetrics["perConcept"][string] {
  return m !== undefined && m.tp > 0 && (m.precision ?? 0) >= 0.9 && positives >= 3;
}
function betterTuningCandidate(
  m: RealPromptMetrics["perConcept"][string],
  threshold: number,
  best: TuningCandidate | undefined,
) {
  if (best === undefined) {
    return true;
  }
  if ((m.recall ?? 0) > best.recall) {
    return true;
  }
  if (m.recall !== best.recall) {
    return false;
  }
  return (
    (m.precision ?? 0) > best.precision ||
    (m.precision === best.precision && threshold > best.threshold)
  );
}
/** Fixed grid plus archived cutoffs. No heldout access and no selective exclusion. */
function developmentPositives(data: RealPromptDataset, id: string) {
  return new Set(
    data.gold
      .filter((g) => {
        const label = g.labels[id];
        return label?.label === "positive" && !label.named;
      })
      .map((g) => g.id),
  ).size;
}
function tuningGrid(baseline: Policy, id: string) {
  const old = baseline.conceptThresholds?.[id];
  return [
    ...new Set([
      ...Array.from({ length: 20 }, (_, i) => (80 + i) / 100),
      ...(old === undefined ? [] : [old]),
    ]),
  ];
}
function tuneExpansion(
  data: RealPromptDataset,
  baseline: Policy,
): { thresholds: Record<string, number>; gaps: string[]; metrics: RealPromptMetrics } {
  check(data.split === "tuning", "Tuning cannot use heldout data.");
  const thresholds = Object.fromEntries(data.concepts.map((c) => [c.id, 0.99]));
  const gaps: string[] = [];
  for (const c of data.concepts) {
    const positives = developmentPositives(data, c.id);
    let best: TuningCandidate | undefined;
    const grid = tuningGrid(baseline, c.id);
    for (const threshold of grid) {
      const m = computeRealPromptMetrics(data, selections({ ...thresholds, [c.id]: threshold }))
        .perConcept[c.id];
      if (qualifiesForTuning(m, positives) && betterTuningCandidate(m, threshold, best)) {
        best = { threshold, recall: m.recall ?? 0, precision: m.precision ?? 0 };
      }
    }
    if (best) {
      thresholds[c.id] = best.threshold;
    } else {
      gaps.push(c.id);
    }
  }
  return { thresholds, gaps, metrics: computeRealPromptMetrics(data, selections(thresholds)) };
}
function score(
  fixtures: Fixture[],
  observations: Observation[],
  catalogue: Catalogue,
  thresholds: Record<string, number>,
  split: "tuning" | "heldout",
) {
  const all = dataset(fixtures, observations, catalogue, split);
  const metrics = (fs: Fixture[]) =>
    computeRealPromptMetrics(dataset(fs, observations, catalogue, split), selections(thresholds));
  return {
    overall: computeRealPromptMetrics(all, selections(thresholds)),
    private: metrics(fixtures.filter((row) => row.kind === "private")),
    synthetic: metrics(fixtures.filter((f) => f.kind === "synthetic")),
    groups: Object.fromEntries(
      [...new Set(fixtures.map((f) => f.group))].map((group) => [
        group,
        metrics(fixtures.filter((f) => f.group === group)).overall,
      ]),
    ),
  };
}
function useful(
  fixtures: Fixture[],
  observations: Observation[],
  thresholds: Record<string, number>,
): number {
  let n = 0;
  for (const f of fixtures.filter((row) => row.kind === "private")) {
    const r = observations.find(
      (x) => x.observation.id === f.id && x.observation.repeat === 0,
    )?.observation;
    if (
      r &&
      Object.entries(thresholds).some(
        ([id, cutoff]) =>
          f.labels[id] === "positive" &&
          !f.named.includes(id) &&
          !r.alreadyNamed.includes(id) &&
          (r.probabilities[id]?.native ?? 0) >= cutoff,
      )
    ) {
      n += 1;
    }
  }
  return n;
}
async function attempt(
  o: ExpansionOptions,
  ledger: LedgerSession,
  registry: EvalRegistry,
  catalogue: Catalogue,
  fixture: Fixture,
  repeat: number,
): Promise<Observation> {
  const id = `${o.phase}/${fixture.id}/${repeat}`;
  check(ledger.snapshot().attempts.length < 360, "360 attempt ceiling reached.");
  await ledger.reserve(id);
  const started = performance.now();
  let settled = false;
  try {
    const result = await (o.matcher ?? matchWithNativeClassifier)(
      registry,
      catalogue,
      fixture.prompt,
      0,
      AbortSignal.timeout(5000),
    );
    check(result.ok, "Native matcher failed (details withheld).");
    const matches = result.value.matches;
    check(
      matches.length === catalogue.recognition.length &&
        new Set(matches.map((m) => m.concept.id)).size === matches.length &&
        matches.every(
          (m) =>
            catalogue.recognition.some((r) => r.conceptId === m.concept.id) &&
            Number.isFinite(m.probability) &&
            m.probability >= 0 &&
            m.probability <= 1,
        ),
      "Incomplete native probabilities.",
    );
    // settleSuccess burns invalid-usage reservations itself.
    settled = true;
    const usage = await ledger.settleSuccess(id, result.value.usage);
    const alreadyNamed = suppressAlreadyNamed(
      extractClassifierText(catalogue, fixture.prompt),
      catalogue,
    );
    const selected = selectMatches(matches, EMPTY, 0, alreadyNamed);
    check(
      selected.length === matches.filter((m) => !alreadyNamed.has(m.concept.id)).length,
      "Unmodelled runtime selector drops; promotion stopped.",
    );
    return {
      observation: {
        id: fixture.id,
        split: o.phase === "tune" ? "tuning" : "heldout",
        repeat,
        alreadyNamed: [...alreadyNamed],
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
      await ledger.settleFailure(id);
    }
    // Keep failure latency and token unavailability in the private artifact, never provider errors.
    await appendFile(
      join(o.output, "failures.jsonl"),
      `${JSON.stringify({ id: fixture.id, repeat, latencyMs: Math.round(performance.now() - started), inputTokens: null, outputTokens: null })}\n`,
      { mode: 0o600 },
    );
    throw new Error("Native attempt failed; reservation retained, no replay permitted.");
  }
}
async function assertBinding(
  o: ExpansionOptions,
  catalogue: Catalogue,
  baseline: Policy,
  binding: Binding,
  entriesToCheck: Entry[],
) {
  check(
    stableHash(await bindingAt(o, catalogue, baseline)) === stableHash(binding),
    "Input/source mutation detected.",
  );
  for (const e of entriesToCheck) {
    check(
      (await hashFile(resolve(dirname(o.manifest), e.file))) === e.sha256,
      "Dataset mutation detected.",
    );
  }
}
function cutoffs(baseline: Policy): Record<string, number> {
  check(
    baseline.conceptThresholds && Object.keys(baseline.conceptThresholds).length === 10,
    "Archived ten-concept baseline required.",
  );
  return { ...baseline.conceptThresholds };
}
function selectedIds(row: Observation, thresholds: Record<string, number>) {
  return Object.entries(thresholds)
    .filter(
      ([id, cutoff]) =>
        !row.observation.alreadyNamed.includes(id) &&
        (row.observation.probabilities[id]?.native ?? 0) >= cutoff,
    )
    .map(([id]) => id)
    .toSorted();
}
function publicMetrics(m: ReturnType<typeof score>) {
  // Metrics contain no prompt IDs or text; private raw observations stay in the fixed local run.
  return m;
}

/** Fixed, single-use phases share one locked ledger. Dry runs never construct auth or write files. */
function validateLocalFixturePaths(o: ExpansionOptions, root: string, m: ExpansionManifest) {
  for (const entry of [...m.development, ...m.heldout]) {
    if (entry.kind === "private" || m.heldout.includes(entry)) {
      check(
        resolve(dirname(o.manifest), entry.file).startsWith(`${resolve(root)}/`),
        "Heldout/private fixtures must remain inside the fixed local run directory.",
      );
    }
  }
}
async function prepareInputs(o: ExpansionOptions) {
  check(["tune", "freeze", "verify"].includes(o.phase), "Unknown phase.");
  check(
    o.writePolicy !== true || (o.phase === "verify" && o.dryRun !== true),
    "Policy publication requires live verify.",
  );
  const root = o.runDir ?? EXPANSION_RUN;
  // All live artifacts, including any private probabilities, must stay inside the fixed run root.
  check(
    resolve(o.output).startsWith(`${resolve(root)}/`),
    "Output must be inside the fixed expansion run directory.",
  );
  const catalogue = o.catalogue ?? loadCatalogue().catalogue;
  check(
    catalogue.concepts.length === 51 && catalogue.recognition.length === 51,
    "Exactly 51 native questions required.",
  );
  const baseline =
    o.baseline ?? (await readJson<Policy>(join(PACKAGE, "evals/production/policy.json")));
  const old = cutoffs(baseline);
  check(
    Object.keys(old).every((id) => catalogue.concepts.some((c) => c.id === id)),
    "Baseline concepts missing.",
  );
  const m = await manifestAt(o.manifest);
  validateLocalFixturePaths(o, root, m);
  return { o, root, catalogue, baseline, old, m };
}
async function frozenInputs(root: string, binding: Binding, ledgerHash: string) {
  const frozen = await readJson<Frozen>(join(root, "freeze.json"));
  const frozenHash = await hashFile(join(root, "freeze.json"));
  const tuning = await readJson<{ thresholds: Record<string, number> }>(
    join(root, "tuning-report.json"),
  );
  check(
    stableHash(frozen.thresholds) === stableHash(tuning.thresholds),
    "Frozen thresholds differ from tuning report.",
  );
  check(stableHash(frozen.binding) === stableHash(binding), "Frozen input binding mismatch.");
  check(frozen.ledgerHash === ledgerHash, "Frozen ledger mismatch.");
  check(
    (await hashFile(join(root, "tuning-report.json"))) === frozen.tuningReport &&
      (await hashFile(join(root, "tuning-observations.json"))) === frozen.tuningObservations,
    "Tuning artifact tampering detected.",
  );
  return { frozen, frozenHash };
}
async function prepareExpansion(o: ExpansionOptions) {
  const { root, catalogue, baseline, old, m } = await prepareInputs(o);
  const binding = await bindingAt(o, catalogue, baseline);
  const ledgerPath = join(root, "eval-ledger.json");
  const ledgerBefore = await readLedger(ledgerPath);
  check(
    ledgerBefore.attempts.length <= 360 &&
      previewBudget(ledgerBefore, 360 - ledgerBefore.attempts.length).fits,
    "All remaining 360 full reservations must fit the $1 cap.",
  );
  let frozen: Frozen | undefined;
  let frozenHash: string | undefined;
  let fixtures: Fixture[] = [];
  if (o.phase === "tune") {
    fixtures = await fixturesAt(o.manifest, m.development, catalogue);
  } else if (o.phase === "verify") {
    ({ frozen, frozenHash } = await frozenInputs(root, binding, stableHash(ledgerBefore)));
  }
  let planned = 0;
  if (o.phase === "tune") {
    planned = fixtures.length;
  } else if (o.phase === "verify") {
    planned = m.heldout.reduce((n, e) => n + e.records, 0) + (m.repeats?.length ?? 0);
  }
  check(
    ledgerBefore.attempts.length + planned <= 360 && previewBudget(ledgerBefore, planned).fits,
    "Attempt budget exceeded.",
  );
  return {
    o,
    root,
    catalogue,
    baseline,
    old,
    m,
    binding,
    ledgerPath,
    ledgerBefore,
    frozen,
    frozenHash,
    fixtures,
    planned,
  };
}
type Prepared = Awaited<ReturnType<typeof prepareExpansion>>;
type LiveRun = Prepared & { ledger: LedgerSession };
async function liveFixtures(run: LiveRun) {
  const { o, m, catalogue, frozen } = run;
  let fixtures = run.fixtures;
  if (o.phase === "verify") {
    // The immutable freeze exists and the phase receipt is burned BEFORE reading heldout bytes.
    fixtures = await fixturesAt(o.manifest, m.heldout, catalogue);
    check(
      fixtures.every((f) => frozen?.developmentPrompts.includes(promptHash(f.prompt)) === false),
      "Heldout overlaps development.",
    );
    check(
      (m.repeats ?? []).every((id) => fixtures.some((f) => f.id === id)),
      "Repeat ID not found.",
    );
    const dev = await fixturesAt(o.manifest, m.development, catalogue);
    check(
      stableHash(dev.map((f) => promptHash(f.prompt))) === stableHash(frozen?.developmentPrompts),
      "Development freshness binding mismatch.",
    );
  }
  return fixtures;
}
async function collectExpansion(run: LiveRun) {
  const { o, m, catalogue, baseline, binding, ledger, fixtures } = run;
  const observations: Observation[] = [];
  const errors: string[] = [];
  try {
    const registry = await (
      o.createRegistry ?? (async () => createNativeRegistry(join(homedir(), ".pi/agent")))
    )();
    check(
      registry.getProviderAuthStatus("typesafe").configured,
      "TypeSafe auth is not configured.",
    );
    const steps = [
      ...fixtures.map((fixture) => ({ fixture, repeat: 0 })),
      ...(o.phase === "verify"
        ? (m.repeats ?? []).map((id) => ({
            fixture: required(fixtures.find((f) => f.id === id)),
            repeat: 1,
          }))
        : []),
    ];
    for (const { fixture, repeat } of steps) {
      const r = await attempt(o, ledger, registry, catalogue, fixture, repeat);
      observations.push(r);
      await appendFile(join(o.output, "observations.jsonl"), `${JSON.stringify(r)}\n`, {
        mode: 0o600,
      });
    }
    await assertBinding(o, catalogue, baseline, binding, [
      ...m.development,
      ...(o.phase === "verify" ? m.heldout : []),
    ]);
  } catch {
    errors.push("Incomplete native run or input integrity failure; no promotion.");
  }
  return { observations, errors };
}
async function latencySummary(o: ExpansionOptions, observations: Observation[]) {
  const failures: { latencyMs: number }[] = [];
  try {
    const failureText = await readFile(join(o.output, "failures.jsonl"), "utf8");
    for (const line of failureText.trim().split("\n")) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This process writes this private failure record immediately before throwing.
      failures.push(JSON.parse(line) as { latencyMs: number });
    }
  } catch {
    /* No dispatched failures, e.g. auth failure. */
  }
  const latencies = [...observations.map((r) => r.latencyMs), ...failures.map((r) => r.latencyMs)];
  const latency = {
    dispatchedAttempts: latencies.length,
    completedWithin5s: observations.filter((r) => r.latencyMs <= 5000).length,
    completedWithin5sRate: latencies.length
      ? observations.filter((r) => r.latencyMs <= 5000).length / latencies.length
      : null,
    failedAttempts: failures.length,
    maxMs: latencies.length ? Math.max(...latencies) : null,
    elapsedMs: latencies,
    note: "All dispatched attempts in denominator, including timeouts/transport errors; failed calls never count as successful <=5s completions.",
  };
  return latency;
}
async function initialReport(run: LiveRun, observations: Observation[], errors: string[]) {
  const { o, binding, planned, ledger } = run;
  const latency = await latencySummary(o, observations);
  const report: Record<string, unknown> = {
    outcome: "error",
    phase: o.phase,
    binding,
    plannedAttempts: planned,
    completedAttempts: observations.length,
    errors,
    budget: budgetTotals(ledger.snapshot()),
    tokens: {
      input: observations.reduce((n, r) => n + r.inputTokens, 0),
      output: observations.reduce((n, r) => n + r.outputTokens, 0),
    },
    latency,
    policyWritten: false,
  };
  return report;
}
async function developmentOutcome(
  run: LiveRun,
  observations: Observation[],
  initial: Record<string, unknown>,
) {
  const { o, fixtures, catalogue, baseline, root, ledger } = run;
  let report = initial;
  const tuned = tuneExpansion(dataset(fixtures, observations, catalogue, "tuning"), baseline);
  report = {
    ...report,
    ...tuned,
    outcome: tuned.gaps.length ? "gaps" : "tuned",
    developmentPrompts: fixtures.map((f) => promptHash(f.prompt)),
  };
  await writeNew(join(root, "tuning-observations.json"), observations);
  const fixedComparators = Object.fromEntries(
    [0.9, 0.95].map((cutoff) => [
      String(cutoff),
      computeRealPromptMetrics(
        dataset(fixtures, observations, catalogue, "tuning"),
        selections(Object.fromEntries(catalogue.concepts.map((c) => [c.id, cutoff]))),
      ),
    ]),
  );
  report = {
    ...report,
    fixedDevelopmentComparators: fixedComparators,
    comparatorNote:
      "Same native probabilities and runtime suppression, no additional calls; observational development comparison only.",
  };
  await writeNew(join(root, "tuning-report.json"), report);
  await writeNew(join(root, "tuning-completion.json"), {
    reportHash: await hashFile(join(root, "tuning-report.json")),
    observationsHash: await hashFile(join(root, "tuning-observations.json")),
    originalObservations: join(o.output, "observations.jsonl"),
    originalHash: await hashFile(join(o.output, "observations.jsonl")),
    ledgerHash: stableHash(ledger.snapshot()),
  });
  return { report, policy: undefined };
}
function repeatSummary(
  observations: Observation[],
  catalogue: Catalogue,
  thresholds: Record<string, number>,
) {
  const probes = observations
    .filter((r) => r.observation.repeat > 0)
    .map((r) => {
      const original = required(
        observations.find(
          (x) => x.observation.id === r.observation.id && x.observation.repeat === 0,
        ),
      );
      const maximumProbabilityDelta = Math.max(
        ...catalogue.concepts.map((c) =>
          Math.abs(
            (r.observation.probabilities[c.id]?.native ?? 0) -
              (original.observation.probabilities[c.id]?.native ?? 0),
          ),
        ),
      );
      return {
        agreement:
          stableHash(selectedIds(original, thresholds)) === stableHash(selectedIds(r, thresholds)),
        maximumProbabilityDelta,
      };
    });
  const repeatStability = {
    probes: probes.length,
    selectedSetAgreements: probes.filter((p) => p.agreement).length,
    selectedSetAgreementRate:
      probes.length > 0 ? probes.filter((p) => p.agreement).length / probes.length : null,
    maximumProbabilityDelta:
      probes.length > 0 ? Math.max(...probes.map((p) => p.maximumProbabilityDelta)) : null,
  };
  return repeatStability;
}
function heldoutOutcome(
  run: LiveRun,
  observations: Observation[],
  initial: Record<string, unknown>,
) {
  const { fixtures, catalogue, frozen, old, binding } = run;
  let report = initial;
  let policy: Policy | undefined;
  check(frozen, "Missing freeze.");
  const metrics = score(fixtures, observations, catalogue, frozen.thresholds, "heldout");
  const baselineThresholds = Object.fromEntries(
    catalogue.concepts.map((c) => [c.id, old[c.id] ?? 1]),
  );
  // Disabled non-baseline concepts must NEVER emit, including probability exactly 1.
  const baselineObservations = observations.map((r) => ({
    ...r,
    observation: {
      ...r.observation,
      alreadyNamed: [
        ...new Set([
          ...r.observation.alreadyNamed,
          ...catalogue.concepts.filter((c) => !Object.hasOwn(old, c.id)).map((c) => c.id),
        ]),
      ],
    },
  }));
  const baselineMetrics = score(
    fixtures,
    baselineObservations,
    catalogue,
    baselineThresholds,
    "heldout",
  );
  const gain =
    useful(fixtures, observations, frozen.thresholds) - useful(fixtures, baselineObservations, old);
  const precisionPass = [metrics.overall, metrics.private, metrics.synthetic].every(
    (x) => (x.overall.precision ?? 0) >= 0.9,
  );
  const recallPass = Object.values(metrics.synthetic.perConcept).every(
    (x) => x.distinctUnnamedPositivePrompts > 0 && (x.recall ?? 0) >= 0.5,
  );
  const passed = precisionPass && recallPass && gain > 0;
  const repeatStability = repeatSummary(observations, catalogue, frozen.thresholds);
  report = {
    ...report,
    outcome: passed ? "passed" : "failed",
    metrics: publicMetrics(metrics),
    baseline: publicMetrics(baselineMetrics),
    usefulPrivatePromptGain: gain,
    noCallBaseline: { reminders: 0, usefulPrompts: 0, falsePositives: 0 },
    individualPrecisionFailures: Object.entries(metrics.overall.perConcept)
      .filter(([, x]) => (x.precision ?? 0) < 0.9)
      .map(([id]) => id),
    comparison:
      "Observational old-ten subset and archived cutoffs on the SAME 51-question native probabilities; not a causal old-ten request comparison.",
    repeatStability,
    repeatObservations: observations.filter((r) => r.observation.repeat > 0).length,
    repeatNote:
      "Repeat probes are reported separately in local raw observations and excluded from primary prompt metrics.",
    uncertainty:
      "Small dependent samples; empirical 90% scored precision is not a guarantee. Ambiguous hits are report-only. No selective concept exclusion.",
  };
  if (passed) {
    policy = {
      schemaVersion: 1,
      model: JEV_MODEL_ID,
      catalogueHash: catalogue.hash,
      criteriaHash: criteriaHash(catalogue),
      fixtureHash: binding.manifest,
      threshold: 0.99,
      conceptThresholds: frozen.thresholds,
      precisionTarget: 0.9,
      measuredDisplayedPrecision: metrics.overall.overall.precision ?? 0,
      measured: true,
    };
  }
  return { report, policy };
}
async function persistExpansion(
  run: LiveRun,
  report: Record<string, unknown>,
  policy: Policy | undefined,
) {
  const { o, catalogue, baseline, binding, m, root, frozenHash, frozen } = run;
  if (policy) {
    await writeNew(join(o.output, "policy.json"), policy);
  }
  // The complete report exists before publication. Rehash every input again immediately before rename.
  await writeNew(join(o.output, "report.json"), report);
  if (policy !== undefined && o.writePolicy === true) {
    await assertBinding(o, catalogue, baseline, binding, [...m.development, ...m.heldout]);
    check(
      (await hashFile(join(root, "freeze.json"))) === frozenHash &&
        (await hashFile(join(root, "tuning-report.json"))) === frozen?.tuningReport &&
        (await hashFile(join(root, "tuning-observations.json"))) === frozen?.tuningObservations,
      "Frozen artifacts mutated before promotion.",
    );
    const target = o.policyPath ?? join(PACKAGE, "glossary/policy.json");
    const tmp = `${target}.${process.pid}.tmp`;
    await writeNew(tmp, policy);
    await rename(tmp, target);
    await writeNew(join(o.output, "promotion-receipt.json"), {
      policyWritten: true,
      policyHash: await hashFile(target),
      reportHash: await hashFile(join(o.output, "report.json")),
      reportNote:
        "report.json is the immutable pre-publication evaluation; this receipt records completed atomic publication.",
    });
    return { ...report, policyWritten: true };
  }
  return report;
}
export async function runExpansion(o: ExpansionOptions): Promise<Record<string, unknown>> {
  const prepared = await prepareExpansion(o);
  if (o.dryRun === true) {
    return {
      outcome: "dry-run",
      phase: o.phase,
      plannedAttempts: prepared.planned,
      heldoutContentRead: false,
      budget: previewBudget(prepared.ledgerBefore, prepared.planned),
      maxAttempts: 360,
    };
  }
  const ledger = await openLedger(prepared.ledgerPath);
  try {
    const run = { ...prepared, ledger };
    check(
      stableHash(ledger.snapshot()) === stableHash(run.ledgerBefore),
      "Ledger changed during preparation.",
    );
    await mkdir(o.output, { mode: 0o700 });
    await writeNew(join(run.root, `${o.phase}-receipt.json`), {
      binding: run.binding,
      planned: run.planned,
      ledgerHash: stableHash(run.ledgerBefore),
    });
    if (o.phase === "freeze") {
      return await freeze(o, run.root, run.catalogue, run.baseline, run.binding, run.m, ledger);
    }
    run.fixtures = await liveFixtures(run);
    const { observations, errors } = await collectExpansion(run);
    let outcome: { report: Record<string, unknown>; policy: Policy | undefined } = {
      report: await initialReport(run, observations, errors),
      policy: undefined,
    };
    if (errors.length === 0 && observations.length === run.planned) {
      outcome =
        o.phase === "tune"
          ? await developmentOutcome(run, observations, outcome.report)
          : heldoutOutcome(run, observations, outcome.report);
    }
    return await persistExpansion(run, outcome.report, outcome.policy);
  } finally {
    await ledger.close();
  }
}

async function freeze(
  o: ExpansionOptions,
  root: string,
  catalogue: Catalogue,
  baseline: Policy,
  binding: Binding,
  m: ExpansionManifest,
  ledger: LedgerSession,
) {
  const report = await readJson<{
    outcome: string;
    binding: Binding;
    thresholds: Record<string, number>;
    developmentPrompts: string[];
    plannedAttempts: number;
  }>(join(root, "tuning-report.json"));
  check(
    report.outcome === "tuned" && stableHash(report.binding) === stableHash(binding),
    "Tuning gaps or changed inputs prevent freezing.",
  );
  const fixtures = await fixturesAt(o.manifest, m.development, catalogue);
  const observations = await readJson<Observation[]>(join(root, "tuning-observations.json"));
  check(
    ledger.snapshot().attempts.length === fixtures.length &&
      ledger.snapshot().attempts.every((a) => a.status === "succeeded"),
    "Tuning ledger incomplete.",
  );
  const seal = await readJson<{
    reportHash: string;
    observationsHash: string;
    originalObservations: string;
    originalHash: string;
    ledgerHash: string;
  }>(join(root, "tuning-completion.json"));
  check(
    resolve(seal.originalObservations).startsWith(`${resolve(root)}/`),
    "Original observations must remain in local run.",
  );
  check(
    seal.reportHash === (await hashFile(join(root, "tuning-report.json"))) &&
      seal.observationsHash === (await hashFile(join(root, "tuning-observations.json"))) &&
      seal.originalHash === (await hashFile(seal.originalObservations)) &&
      seal.ledgerHash === stableHash(ledger.snapshot()),
    "Tuning completion seal mismatch.",
  );
  const originalText = await readFile(seal.originalObservations, "utf8");
  const originals: unknown[] = originalText
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line));
  check(
    stableHash(originals) === stableHash(observations),
    "Tuning observations differ from original native log.",
  );
  const recomputed = tuneExpansion(dataset(fixtures, observations, catalogue, "tuning"), baseline);
  check(
    recomputed.gaps.length === 0 &&
      stableHash(recomputed.thresholds) === stableHash(report.thresholds),
    "Tuning report does not reproduce.",
  );
  check(
    observations.every((r) =>
      ledger
        .snapshot()
        .attempts.some(
          (a) =>
            a.recordId === `tune/${r.observation.id}/0` &&
            a.inputTokens === r.inputTokens &&
            a.outputTokens === r.outputTokens,
        ),
    ),
    "Tuning observations do not match ledger.",
  );
  await assertBinding(o, catalogue, baseline, binding, m.development);
  const frozen: Frozen = {
    binding,
    thresholds: report.thresholds,
    tuningReport: await hashFile(join(root, "tuning-report.json")),
    tuningObservations: await hashFile(join(root, "tuning-observations.json")),
    developmentPrompts: fixtures.map((f) => promptHash(f.prompt)),
    ledgerHash: stableHash(ledger.snapshot()),
  };
  await writeNew(join(root, "freeze.json"), frozen);
  await writeNew(join(o.output, "report.json"), { outcome: "frozen", ...frozen });
  return { outcome: "frozen", heldoutContentRead: false };
}
export async function main(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      phase: { type: "string" },
      manifest: { type: "string" },
      output: { type: "string" },
      "dry-run": { type: "boolean" },
      "write-policy": { type: "boolean" },
    },
  });
  check(
    values.phase === "tune" || values.phase === "freeze" || values.phase === "verify",
    "--phase tune|freeze|verify required.",
  );
  check(
    typeof values.manifest === "string" &&
      values.manifest.length > 0 &&
      typeof values.output === "string" &&
      values.output.length > 0,
    "--manifest and --output required.",
  );
  return runExpansion({
    phase: values.phase,
    manifest: resolve(values.manifest),
    output: resolve(values.output),
    dryRun: values["dry-run"] === true,
    writePolicy: values["write-policy"] === true,
  });
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = ["dry-run", "tuned", "frozen", "passed"].includes(String(report.outcome))
      ? 0
      : 1;
  } catch {
    process.stderr.write(
      "Expansion evaluation refused or incomplete; inspect local receipts. No retry/replay is permitted.\n",
    );
    process.exitCode = 1;
  }
}
