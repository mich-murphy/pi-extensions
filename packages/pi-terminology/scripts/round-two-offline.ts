import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { criteriaHash, loadCatalogue } from "../catalogue";
import { openLedger } from "../eval-budget";
import type { LedgerSession } from "../eval-budget";
import type { EvalFixture } from "../eval-metrics";
import { JEV_MODEL_ID } from "../native-matcher";
import type { Catalogue, Policy } from "../types";
import { stableHash } from "../validation";
import { betterScore, chooseThreshold } from "./eval-screen";
import type { RawObservation, Screen } from "./eval-screen";
import {
  VARIANTS,
  artifactHash,
  freezeRound,
  hashBytes,
  isRecord,
  readCandidate,
  readJson,
  readRoundState,
  roundContext,
  roundError,
  roundPrefix,
  writeExclusive,
} from "./round-two-state";
import type { RoundContext, RoundReceipt, RoundState, Variant } from "./round-two-state";

export type OfflineOptions = {
  readonly operation?: "select" | "freeze";
  readonly instructionsRun?: string;
  readonly criteriaRun?: string;
  readonly selection?: string;
  readonly output: string;
};
export type OfflinePaths = {
  /** Historical/offline dependency only, not an operator CLI path override. */
  readonly catalogue?: Catalogue;
  readonly ledgerPath: string;
  readonly evalsDir: string;
  readonly policyPath: string;
  readonly now: () => Date;
};

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
async function development(
  context: RoundContext,
): Promise<{ readonly fixtures: readonly EvalFixture[]; readonly hash: string }> {
  const manifest = await readJson(join(context.evalsDir, "manifest.json"));
  const text = await readFile(join(context.evalsDir, "development.json"), "utf8");
  if (
    !isRecord(manifest) ||
    !isRecord(manifest.development) ||
    manifest.development.sha256 !== hashBytes(text)
  ) {
    throw roundError("development fixture hash mismatch");
  }
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length !== 30) {
    throw roundError("development must contain 30 prompts");
  }
  const fixtures = value.map((item: unknown): EvalFixture => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.prompt !== "string" ||
      !strings(item.applicable) ||
      !strings(item.displayed)
    ) {
      throw roundError("invalid development fixture");
    }
    return {
      id: item.id,
      prompt: item.prompt,
      applicable: item.applicable,
      displayed: item.displayed,
    };
  });
  return { fixtures, hash: hashBytes(text) };
}
function validRaw(value: unknown, conceptIds: readonly string[]): value is RawObservation {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    (value.repeat !== 0 && value.repeat !== 1) ||
    !isRecord(value.probabilities)
  ) {
    return false;
  }
  const probabilities = value.probabilities;
  return (
    Object.keys(probabilities).length === 6 &&
    conceptIds.every(
      (id) =>
        typeof probabilities[id] === "number" &&
        Number.isFinite(probabilities[id]) &&
        probabilities[id] >= 0 &&
        probabilities[id] <= 1,
    ) &&
    typeof value.latencyMs === "number" &&
    Number.isFinite(value.latencyMs) &&
    value.latencyMs >= 0 &&
    typeof value.inputTokens === "number" &&
    Number.isSafeInteger(value.inputTokens) &&
    value.inputTokens > 0 &&
    value.inputTokens <= 65_536 &&
    typeof value.outputTokens === "number" &&
    Number.isSafeInteger(value.outputTokens) &&
    value.outputTokens >= 0
  );
}
async function observations(
  outputDir: string,
  conceptIds: readonly string[],
  fixtures: readonly EvalFixture[],
): Promise<readonly RawObservation[]> {
  // U+2028 and U+2029 are legal within JSON strings. Only LF delimits records.
  const text = await readFile(join(outputDir, "observations.jsonl"), "utf8");
  const lines = text.split("\n");
  if (lines.at(-1) !== "") {
    throw roundError("incomplete observation archive");
  }
  lines.pop();
  const raws = lines.map((line) => {
    const value: unknown = JSON.parse(line);
    if (!validRaw(value, conceptIds)) {
      throw roundError("invalid archived probability or usage");
    }
    return value;
  });
  const expected = new Set(
    fixtures.flatMap((fixture) => [0, 1].map((repeat) => `${fixture.id}/${String(repeat)}`)),
  );
  for (const raw of raws) {
    if (!expected.delete(`${raw.id}/${String(raw.repeat)}`)) {
      throw roundError("duplicate or unexpected observation");
    }
  }
  if (raws.length !== 60 || expected.size !== 0) {
    throw roundError("missing observations");
  }
  return raws;
}

async function variantEvidence(
  context: RoundContext,
  ledger: LedgerSession,
  variant: Variant,
  outputDir: string,
  fixtures: readonly EvalFixture[],
) {
  const state: RoundState = await readRoundState(context, ledger);
  const receipt: RoundReceipt | undefined = state.receipts[variant];
  const hash = await artifactHash(outputDir);
  const integrity = await readJson(join(outputDir, "integrity.json"));
  if (
    receipt?.outputDir !== outputDir ||
    receipt.artifactHash !== hash ||
    !isRecord(integrity) ||
    integrity.artifactHash !== hash ||
    integrity.binding !== context.binding
  ) {
    throw roundError("development artifacts do not match the immutable native receipt");
  }
  const candidate = await readCandidate(join(outputDir, "candidate.json"));
  if (candidate.fileHash !== context.candidates[variant].fileHash) {
    throw roundError("archived candidate mismatch");
  }
  const questions = await readJson(join(outputDir, "questions.json"));
  if (stableHash(questions) !== candidate.criteria) {
    throw roundError("compiled question snapshot mismatch");
  }
  const report = await readJson(join(outputDir, "run.json"));
  if (
    !isRecord(report) ||
    report.binding !== context.binding ||
    report.variant !== variant ||
    report.plannedAttempts !== 60 ||
    !Array.isArray(report.errors) ||
    report.errors.length !== 0 ||
    report.outcome === "error"
  ) {
    throw roundError("development run did not complete cleanly");
  }
  const raws = await observations(
    outputDir,
    candidate.catalogue.concepts.map((concept) => concept.id),
    fixtures,
  );
  validateSettlements(ledger, variant, raws);
  const screen: Screen = {
    catalogue: candidate.catalogue,
    fixtures,
    planned: 60,
    options: { dataset: "v2", now: () => new Date(0) },
  };
  const { rows, best } = chooseThreshold(screen, raws);
  return {
    candidateId: variant,
    outputDir,
    artifactHash: hash,
    candidateFileHash: candidate.fileHash,
    catalogueHash: candidate.catalogue.hash,
    criteriaHash: candidate.criteria,
    compiledQuestions: candidate.catalogue.recognition.map((recognition) => [
      recognition.conceptId,
      recognition.question,
    ]),
    sweep: rows,
    best: best ?? null,
  };
}
function validateSettlements(
  ledger: LedgerSession,
  variant: Variant,
  raws: readonly RawObservation[],
): void {
  const prefix = roundPrefix(variant);
  const attempts = ledger
    .snapshot()
    .attempts.filter((attempt) => attempt.recordId.startsWith(prefix));
  const byId = new Map(attempts.map((attempt) => [attempt.recordId, attempt]));
  if (attempts.length !== 60) {
    throw roundError("development reservation count mismatch");
  }
  for (const raw of raws) {
    const attempt = byId.get(`${prefix}${raw.id}/${String(raw.repeat)}`);
    if (
      attempt?.status !== "succeeded" ||
      attempt.inputTokens !== raw.inputTokens ||
      attempt.outputTokens !== raw.outputTokens ||
      attempt.observedNanos !== raw.inputTokens * 42
    ) {
      throw roundError("development ledger settlement mismatch");
    }
  }
}
async function selectionEvidence(
  context: RoundContext,
  ledger: LedgerSession,
  instructionsDir: string,
  criteriaDir: string,
) {
  const state: RoundState = await readRoundState(context, ledger);
  if (state.receipts.heldout !== undefined) {
    throw roundError("selection cannot inspect a consumed held-out experiment");
  }
  const { fixtures, hash } = await development(context);
  const candidates = await Promise.all(
    VARIANTS.map(async (variant) =>
      variantEvidence(
        context,
        ledger,
        variant,
        variant === "instructions-focused" ? instructionsDir : criteriaDir,
        fixtures,
      ),
    ),
  );
  // Ascending IDs establish the deterministic final tie-breaker. Strict improvement only.
  let winner: (typeof candidates)[number] | undefined;
  for (const candidate of candidates) {
    if (candidate.best === null) {
      continue;
    }
    if (
      winner === undefined ||
      winner.best === null ||
      (betterScore(candidate.best, winner.best) && !betterScore(winner.best, candidate.best))
    ) {
      winner = candidate;
    }
  }
  const best = winner?.best;
  const policy: Policy | null =
    winner === undefined || best === null || best === undefined
      ? null
      : {
          schemaVersion: 1,
          model: JEV_MODEL_ID,
          catalogueHash: winner.catalogueHash,
          criteriaHash: winner.criteriaHash,
          fixtureHash: hash,
          threshold: best.threshold,
          measuredDisplayedPrecision: best.metrics.displayed.precision ?? 0,
          measured: false,
        };
  return {
    schemaVersion: 1,
    dataset: "v2",
    binding: context.binding,
    model: JEV_MODEL_ID,
    developmentFixtureHash: hash,
    candidates,
    selectedCandidate: winner?.candidateId ?? null,
    policy,
  };
}

async function select(options: OfflineOptions, context: RoundContext, ledger: LedgerSession) {
  if (
    options.instructionsRun === undefined ||
    options.criteriaRun === undefined ||
    options.output === "" ||
    options.selection !== undefined
  ) {
    throw roundError("selection needs both development directories and a new output directory");
  }
  const evidence = await selectionEvidence(
    context,
    ledger,
    resolve(options.instructionsRun),
    resolve(options.criteriaRun),
  );
  const outputDir = resolve(options.output);
  await mkdir(dirname(outputDir), { recursive: true });
  await mkdir(outputDir);
  await writeExclusive(join(outputDir, "selection.json"), evidence);
  await Promise.all(
    VARIANTS.map(async (variant) =>
      writeFile(join(outputDir, `${variant}.json`), context.candidates[variant].text, {
        flag: "wx",
      }),
    ),
  );
  if (evidence.policy !== null) {
    await writeExclusive(join(outputDir, "policy.json"), evidence.policy);
  }
  return {
    outcome: evidence.policy === null ? "no-policy" : "selected",
    selectedCandidate: evidence.selectedCandidate,
    selectionHash: stableHash(evidence),
    outputDir,
  };
}
async function validateSelectionSnapshots(context: RoundContext, outputDir: string): Promise<void> {
  await Promise.all(
    VARIANTS.map(async (variant) => {
      const snapshot = await readCandidate(join(outputDir, `${variant}.json`));
      if (snapshot.fileHash !== context.candidates[variant].fileHash) {
        throw roundError("selected snapshot or unmeasured policy mismatch");
      }
    }),
  );
}
async function freeze(
  options: OfflineOptions,
  context: RoundContext,
  ledger: LedgerSession,
  paths: OfflinePaths,
) {
  if (
    options.selection === undefined ||
    options.output !== "" ||
    options.instructionsRun !== undefined ||
    options.criteriaRun !== undefined
  ) {
    throw roundError("freeze needs only --selection DIR");
  }
  const outputDir = resolve(options.selection);
  const supplied = await readJson(join(outputDir, "selection.json"));
  if (!isRecord(supplied) || !Array.isArray(supplied.candidates)) {
    throw roundError("invalid selection evidence");
  }
  const directories = supplied.candidates.map((candidate: unknown) =>
    isRecord(candidate) && typeof candidate.outputDir === "string" ? candidate.outputDir : "",
  );
  if (directories.length !== 2 || directories.some((directory) => directory === "")) {
    throw roundError("selection needs two development receipts");
  }
  const expected = await selectionEvidence(
    context,
    ledger,
    directories[0] ?? "",
    directories[1] ?? "",
  );
  if (
    stableHash(expected) !== stableHash(supplied) ||
    expected.policy === null ||
    expected.selectedCandidate === null
  ) {
    throw roundError("selection evidence was changed or no candidate qualifies");
  }
  const selected = context.candidates[expected.selectedCandidate];
  await validateSelectionSnapshots(context, outputDir);
  const policy = await readJson(join(outputDir, "policy.json"));
  if (stableHash(policy) !== stableHash(expected.policy)) {
    throw roundError("selected snapshot or unmeasured policy mismatch");
  }
  const current = paths.catalogue ?? loadCatalogue().catalogue;
  if (current.hash !== selected.catalogue.hash || criteriaHash(current) !== selected.criteria) {
    throw roundError(
      `apply ${expected.selectedCandidate}.json to the bundled core before freezing`,
    );
  }
  const selectionHash = stableHash(expected);
  await freezeRound(context, ledger, {
    selectionHash,
    candidate: expected.selectedCandidate,
    policy: expected.policy,
  });
  const temporary = `${paths.policyPath}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(expected.policy, null, 2)}\n`);
  await rename(temporary, paths.policyPath);
  await writeExclusive(join(outputDir, "freeze.json"), {
    selectionHash,
    binding: context.binding,
    candidate: expected.selectedCandidate,
    policyHash: stableHash(expected.policy),
    frozenAt: paths.now().toISOString(),
  });
  return { outcome: "frozen", selectedCandidate: expected.selectedCandidate, selectionHash };
}

/** Offline operations share the native cumulative lock but never construct a registry or load held-out prompts. */
export async function runOfflineOperation(options: OfflineOptions, paths: OfflinePaths) {
  const context = await roundContext(paths.evalsDir, paths.ledgerPath);
  const ledger = await openLedger(paths.ledgerPath, paths.now);
  try {
    if (options.operation === "select") {
      return await select(options, context, ledger);
    }
    if (options.operation === "freeze") {
      return await freeze(options, context, ledger, paths);
    }
    throw roundError("unknown offline operation");
  } finally {
    await ledger.close();
  }
}
