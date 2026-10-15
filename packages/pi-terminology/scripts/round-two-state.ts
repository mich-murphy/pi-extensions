import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { criteriaHash } from "../catalogue";
import { BudgetError } from "../eval-budget";
import type { LedgerSession } from "../eval-budget";
import type { EvalFixture } from "../eval-metrics";
import type { Catalogue, GlossaryDocument, Policy } from "../types";
import { composeGlossaries, normalizeLabel, parseGlossary, stableHash } from "../validation";

export const VARIANTS = ["instructions-focused", "with-criteria"] as const;
export type Variant = (typeof VARIANTS)[number];
export type RoundKey = Variant | "heldout";
export type Candidate = {
  readonly document: GlossaryDocument;
  readonly text: string;
  readonly fileHash: string;
  readonly catalogue: Catalogue;
  readonly criteria: string;
};
export type RoundContext = {
  readonly evalsDir: string;
  readonly ledgerPath: string;
  readonly binding: string;
  readonly developmentHash: string;
  readonly heldoutHash: string;
  readonly candidates: Readonly<Record<Variant, Candidate>>;
};
export type RoundReceipt = {
  readonly runId: string;
  readonly outputDir: string;
  readonly planned: number;
  readonly artifactHash: string | null;
};
export type RoundFreeze = {
  readonly selectionHash: string;
  readonly candidate: Variant;
  readonly policy: Policy;
};
export type RoundState = {
  readonly schemaVersion: 1;
  readonly binding: string;
  readonly baselineHash: string;
  readonly consumedPrompts: readonly string[];
  readonly receipts: Partial<Record<RoundKey, RoundReceipt>>;
  readonly freeze: RoundFreeze | null;
};

export function roundError(detail: string): BudgetError {
  return new BudgetError(`Round two refused: ${detail}.`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isVariant(value: unknown): value is Variant {
  return value === "instructions-focused" || value === "with-criteria";
}
export function hashBytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function promptHash(prompt: string): string {
  return stableHash(normalizeLabel(prompt));
}
export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
export async function writeExclusive(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}
async function writeState(context: RoundContext, state: RoundState): Promise<void> {
  const path = statePath(context);
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporary, path);
}
function nativeReceiptPath(context: RoundContext, key: RoundKey): string {
  return join(dirname(context.ledgerPath), `round-2-${key}-receipt.json`);
}
function statePath(context: RoundContext): string {
  return join(dirname(context.ledgerPath), "round-2.json");
}
export function roundPrefix(key: RoundKey): string {
  return `round-2/${key}/`;
}

export async function readCandidate(path: string): Promise<Candidate> {
  const text = await readFile(path, "utf8");
  const parsed = parseGlossary(JSON.parse(text) as unknown, "evaluation candidate", "core");
  if (!parsed.ok) {
    throw roundError("invalid candidate glossary");
  }
  const composed = composeGlossaries([parsed.value]);
  if (
    !composed.ok ||
    composed.value.concepts.length !== 6 ||
    composed.value.recognition.length !== 6
  ) {
    throw roundError("candidate needs six concepts and questions");
  }
  return {
    document: parsed.value,
    text,
    fileHash: hashBytes(text),
    catalogue: composed.value,
    criteria: criteriaHash(composed.value),
  };
}
function semanticHash(document: GlossaryDocument): string {
  return stableHash({
    ...document,
    recognition: document.recognition.map((recognition) => ({
      conceptId: recognition.conceptId,
      matches: recognition.matches,
      doesNotMatch: recognition.doesNotMatch,
      tip: recognition.tip,
      caution: recognition.caution ?? null,
    })),
  });
}
export async function roundContext(evalsDir: string, ledgerPath: string): Promise<RoundContext> {
  const instructions = await readCandidate(
    join(evalsDir, "candidates", "instructions-focused.json"),
  );
  const criteria = await readCandidate(join(evalsDir, "candidates", "with-criteria.json"));
  if (
    instructions.document.recognition.some(
      (recognition) => recognition.questionStyle !== "instructions-focused",
    ) ||
    criteria.document.recognition.some(
      (recognition) => (recognition.questionStyle ?? "with-criteria") !== "with-criteria",
    )
  ) {
    throw roundError("candidate styles do not match the fixed variant IDs");
  }
  if (semanticHash(instructions.document) !== semanticHash(criteria.document)) {
    throw roundError("candidate meanings or boundaries differ");
  }
  const manifest = await readJson(join(evalsDir, "manifest.json"));
  if (
    !isRecord(manifest) ||
    !isRecord(manifest.development) ||
    !isRecord(manifest.heldout) ||
    typeof manifest.development.sha256 !== "string" ||
    typeof manifest.heldout.sha256 !== "string"
  ) {
    throw roundError("invalid fixture manifest");
  }
  const candidates = { "instructions-focused": instructions, "with-criteria": criteria };
  const binding = stableHash({
    manifest,
    candidates: VARIANTS.map((id) => [
      id,
      candidates[id].fileHash,
      candidates[id].catalogue.hash,
      candidates[id].criteria,
    ]),
  });
  return {
    evalsDir,
    ledgerPath,
    binding,
    developmentHash: manifest.development.sha256,
    heldoutHash: manifest.heldout.sha256,
    candidates,
  };
}

function baselineHash(ledger: LedgerSession): string {
  const snapshot = ledger.snapshot();
  return stableHash({
    otherCostNanos: snapshot.otherCostNanos,
    attempts: snapshot.attempts.filter((attempt) => !attempt.recordId.startsWith("round-2/")),
  });
}
function validReceipt(value: unknown): value is RoundReceipt {
  return (
    isRecord(value) &&
    typeof value.runId === "string" &&
    typeof value.outputDir === "string" &&
    (value.planned === 60 || value.planned === 80) &&
    (value.artifactHash === null || typeof value.artifactHash === "string")
  );
}
function validFreeze(value: unknown): value is RoundFreeze | null {
  if (value === null) {
    return true;
  }
  if (
    !isRecord(value) ||
    typeof value.selectionHash !== "string" ||
    !isVariant(value.candidate) ||
    !isRecord(value.policy)
  ) {
    return false;
  }
  const policy = value.policy;
  return (
    policy.schemaVersion === 1 &&
    policy.model === "jev-1.13.0" &&
    policy.measured === false &&
    typeof policy.catalogueHash === "string" &&
    typeof policy.criteriaHash === "string" &&
    typeof policy.fixtureHash === "string" &&
    typeof policy.threshold === "number" &&
    Number.isFinite(policy.threshold) &&
    policy.threshold >= 0.5 &&
    policy.threshold <= 0.99 &&
    typeof policy.measuredDisplayedPrecision === "number" &&
    Number.isFinite(policy.measuredDisplayedPrecision) &&
    policy.measuredDisplayedPrecision >= 0.95 &&
    policy.measuredDisplayedPrecision <= 1
  );
}
function validState(value: unknown): value is RoundState {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.binding === "string" &&
    typeof value.baselineHash === "string" &&
    Array.isArray(value.consumedPrompts) &&
    value.consumedPrompts.every(
      (hash: unknown) => typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash),
    ) &&
    isRecord(value.receipts) &&
    Object.entries(value.receipts).every(
      ([key, receipt]) => (isVariant(key) || key === "heldout") && validReceipt(receipt),
    ) &&
    validFreeze(value.freeze)
  );
}

/** Must be called only while holding the cumulative ledger lock. No stale-lock recovery. */
export async function readRoundState(
  context: RoundContext,
  ledger: LedgerSession,
): Promise<RoundState> {
  let value: unknown;
  try {
    value = await readJson(statePath(context));
  } catch (error: unknown) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw roundError("corrupt round receipt");
    }
    if (ledger.snapshot().attempts.some((attempt) => attempt.recordId.startsWith("round-2/"))) {
      throw roundError("missing round receipt with existing reservations");
    }
    value = {
      schemaVersion: 1,
      binding: context.binding,
      baselineHash: baselineHash(ledger),
      consumedPrompts: await legacyConsumed(context, ledger),
      receipts: {},
      freeze: null,
    };
  }
  if (
    !validState(value) ||
    value.binding !== context.binding ||
    value.baselineHash !== baselineHash(ledger)
  ) {
    throw roundError("receipt or cumulative budget binding mismatch");
  }
  if (value.freeze !== null) {
    const candidate = context.candidates[value.freeze.candidate];
    if (
      value.freeze.policy.catalogueHash !== candidate.catalogue.hash ||
      value.freeze.policy.criteriaHash !== candidate.criteria ||
      value.freeze.policy.fixtureHash !== context.developmentHash
    ) {
      throw roundError("frozen candidate provenance mismatch");
    }
  }
  validateRoundReservations(value, ledger);
  await Promise.all(
    ([...VARIANTS, "heldout"] as const).map(async (key) =>
      validateNativeReceipt(context, value, key),
    ),
  );
  return value;
}
async function validateNativeReceipt(
  context: RoundContext,
  state: RoundState,
  key: RoundKey,
): Promise<void> {
  let receipt: unknown;
  try {
    receipt = await readJson(nativeReceiptPath(context, key));
  } catch (error: unknown) {
    if (!isRecord(error) || error.code !== "ENOENT" || state.receipts[key] !== undefined) {
      throw roundError("missing or corrupt immutable native receipt");
    }
    return;
  }
  const current = state.receipts[key];
  if (
    current === undefined ||
    !isRecord(receipt) ||
    stableHash(receipt) !==
      stableHash({
        binding: context.binding,
        key,
        runId: current.runId,
        outputDir: current.outputDir,
        planned: current.planned,
      })
  ) {
    throw roundError("immutable receipt mismatch");
  }
}
function validateRoundReservations(state: RoundState, ledger: LedgerSession): void {
  const attempts = ledger
    .snapshot()
    .attempts.filter((attempt) => attempt.recordId.startsWith("round-2/"));
  if (attempts.length > 200) {
    throw roundError("200-attempt allowance exhausted");
  }
  for (const key of [...VARIANTS, "heldout"] as const) {
    const mine = attempts.filter((attempt) => attempt.recordId.startsWith(roundPrefix(key)));
    const receipt = state.receipts[key];
    if (receipt !== undefined && receipt.planned !== (key === "heldout" ? 80 : 60)) {
      throw roundError("receipt allowance mismatch");
    }
    if (mine.length > (receipt?.planned ?? 0)) {
      throw roundError("reservation has no matching receipt allowance");
    }
  }
  if (
    attempts.some(
      (attempt) =>
        ![...VARIANTS, "heldout"].some((key) => attempt.recordId.startsWith(`round-2/${key}/`)),
    )
  ) {
    throw roundError("unknown round reservation");
  }
}

async function legacyConsumed(
  context: RoundContext,
  ledger: LedgerSession,
): Promise<readonly string[]> {
  let receipt: unknown;
  try {
    receipt = await readJson(join(dirname(context.ledgerPath), "heldout-receipt.json"));
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") {
      if (ledger.snapshot().attempts.some((attempt) => attempt.recordId.includes("/heldout/"))) {
        throw roundError("legacy held-out reservations have no receipt");
      }
      return [];
    }
    throw roundError("invalid legacy consumed-set receipt");
  }
  const manifest = await readJson(join(context.evalsDir, "..", "manifest.json"));
  if (
    !isRecord(receipt) ||
    !isRecord(manifest) ||
    !isRecord(manifest.heldout) ||
    receipt.heldoutFixtureHash !== manifest.heldout.sha256
  ) {
    throw roundError("legacy receipt fixture mismatch");
  }
  const bytes = await readFile(join(context.evalsDir, "..", "heldout.json"));
  if (hashBytes(bytes) !== receipt.heldoutFixtureHash) {
    throw roundError("legacy consumed fixture was modified");
  }
  const fixtures: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !Array.isArray(fixtures) ||
    !fixtures.every((fixture: unknown) => isRecord(fixture) && typeof fixture.prompt === "string")
  ) {
    throw roundError("invalid legacy consumed prompts");
  }
  return fixtures.map((fixture: { readonly prompt: string }) => promptHash(fixture.prompt));
}

/** The native ledger itself is the persistent dispatched-attempt counter, including failures. */
export async function reserveRoundAttempt(
  ledger: LedgerSession,
  key: RoundKey,
  recordId: string,
): Promise<void> {
  const attempts = ledger
    .snapshot()
    .attempts.filter((attempt) => attempt.recordId.startsWith("round-2/"));
  const prefix = roundPrefix(key);
  if (
    !recordId.startsWith(prefix) ||
    attempts.length >= 200 ||
    attempts.filter((attempt) => attempt.recordId.startsWith(prefix)).length >=
      (key === "heldout" ? 80 : 60)
  ) {
    throw roundError("persistent round or variant dispatch allowance exhausted");
  }
  await ledger.reserve(recordId);
}

export async function startRound(
  context: RoundContext,
  ledger: LedgerSession,
  key: RoundKey,
  runId: string,
  outputDir: string,
): Promise<void> {
  const state = await readRoundState(context, ledger);
  if (state.receipts[key] !== undefined) {
    throw roundError("this variant or held-out split was already started");
  }
  if (key === "heldout" && state.freeze === null) {
    throw roundError("no offline policy freeze");
  }
  const planned = key === "heldout" ? 80 : 60;
  const granted = Object.values(state.receipts).reduce((sum, receipt) => sum + receipt.planned, 0);
  if (granted + planned > 200) {
    throw roundError("200-attempt allowance exhausted");
  }
  const receipt = { runId, outputDir, planned, artifactHash: null };
  const next = { ...state, receipts: { ...state.receipts, [key]: receipt } };
  await writeExclusive(nativeReceiptPath(context, key), {
    binding: context.binding,
    key,
    runId,
    outputDir,
    planned,
  });
  await writeState(context, next);
  await writeExclusive(join(outputDir, "round-receipt.json"), {
    binding: context.binding,
    key,
    ...receipt,
  });
}

export async function registerPrompts(
  context: RoundContext,
  ledger: LedgerSession,
  key: RoundKey,
  fixtures: readonly EvalFixture[],
): Promise<void> {
  const state = await readRoundState(context, ledger);
  const hashes = fixtures.map((fixture) => promptHash(fixture.prompt));
  if (
    new Set(fixtures.map((fixture) => fixture.id)).size !== fixtures.length ||
    new Set(hashes).size !== hashes.length
  ) {
    throw roundError("fixture IDs and canonical prompts must be distinct");
  }
  if (key === "heldout" && hashes.some((hash) => state.consumedPrompts.includes(hash))) {
    throw roundError("held-out prompts overlap a consumed set or development");
  }
  await writeState(context, {
    ...state,
    consumedPrompts: [...new Set([...state.consumedPrompts, ...hashes])],
  });
}

const ARTIFACT_FILES = [
  "run.json",
  "observations.jsonl",
  "candidate.json",
  "questions.json",
  "round-receipt.json",
];
export async function artifactHash(outputDir: string): Promise<string> {
  const hashes = await Promise.all(
    ARTIFACT_FILES.map(async (file) => [file, hashBytes(await readFile(join(outputDir, file)))]),
  );
  let policyHash: string | null = null;
  try {
    policyHash = hashBytes(await readFile(join(outputDir, "policy.json")));
  } catch (error: unknown) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  return stableHash({ hashes, policyHash });
}
export async function finishRound(
  context: RoundContext,
  ledger: LedgerSession,
  key: RoundKey,
  outputDir: string,
): Promise<void> {
  const state = await readRoundState(context, ledger);
  const receipt = state.receipts[key];
  if (receipt === undefined || receipt.outputDir !== outputDir || receipt.artifactHash !== null) {
    throw roundError("invalid completion receipt");
  }
  const hash = await artifactHash(outputDir);
  await writeExclusive(join(outputDir, "integrity.json"), {
    artifactHash: hash,
    binding: context.binding,
  });
  await writeState(context, {
    ...state,
    receipts: { ...state.receipts, [key]: { ...receipt, artifactHash: hash } },
  });
}
export async function freezeRound(
  context: RoundContext,
  ledger: LedgerSession,
  freeze: RoundFreeze,
): Promise<void> {
  const state = await readRoundState(context, ledger);
  if (state.freeze !== null || state.receipts.heldout !== undefined) {
    throw roundError("policy was already frozen");
  }
  await writeState(context, { ...state, freeze });
}
