import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Official tariff: https://docs.typesafe.ai/models lists jev-1.13.0 input at $0.042 per million tokens and output free. */
export const JEV_PRICING_URL = "https://docs.typesafe.ai/models";
export const INPUT_NANOS_PER_TOKEN = 42;
/**
 * TypeSafe documents a 64k-token total input limit for state plus questions and a 32k-token
 * sublimit for state plus the longest question. The reservation uses the full 65,536-token total
 * limit at the official input tariff, which is conservative for these tiny public fixtures.
 */
const MAX_REQUEST_INPUT_TOKENS = 65_536;
export const ATTEMPT_RESERVATION_NANOS = MAX_REQUEST_INPUT_TOKENS * INPUT_NANOS_PER_TOKEN;
export const JEV_CAP_NANOS = 1_000_000_000;
export const OVERALL_CAP_NANOS = 5_000_000_000;

export type AttemptStatus = "reserved" | "succeeded" | "failed";

export type AttemptRecord = {
  readonly recordId: string;
  readonly reservedNanos: number;
  readonly status: AttemptStatus;
  readonly startedAt: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Observed input tokens at the documented tariff. Separate from the retained reservation. */
  readonly observedNanos: number | null;
  /** The catalog cost Pi reported, in dollars. Informational: a zero catalog price is not reliable. */
  readonly nativeCostUsd: number | null;
};

export type Ledger = {
  readonly schemaVersion: 1;
  /** Recorded cost from other sources. None exists today. */
  readonly otherCostNanos: number;
  readonly attempts: readonly AttemptRecord[];
};

export type UsageObservation = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly observedNanos: number;
  readonly nativeCostUsd: number | null;
};

export type BudgetTotals = {
  readonly attempts: number;
  readonly jevReservedNanos: number;
  readonly jevObservedNanos: number;
  readonly otherCostNanos: number;
  readonly overallNanos: number;
};

export type BudgetPreview = BudgetTotals & {
  readonly plannedAttempts: number;
  readonly plannedReserveNanos: number;
  readonly projectedJevNanos: number;
  readonly projectedOverallNanos: number;
  readonly jevRemainingNanos: number;
  readonly overallRemainingNanos: number;
  readonly fits: boolean;
};

export class BudgetError extends Error {
  override readonly name = "BudgetError";
}

export type LedgerSession = {
  readonly snapshot: () => Ledger;
  /** Reserves the full request cost and persists it before the caller may make the request. */
  readonly reserve: (recordId: string) => Promise<AttemptRecord>;
  /** Validates usage. Invalid usage marks the attempt failed, keeps the reservation and throws. */
  readonly settleSuccess: (recordId: string, usage: unknown) => Promise<AttemptRecord>;
  readonly settleFailure: (recordId: string) => Promise<AttemptRecord>;
  readonly close: () => Promise<void>;
};

export function emptyLedger(): Ledger {
  return { schemaVersion: 1, otherCostNanos: 0, attempts: [] };
}

export function ledgerPathFor(agentDir: string): string {
  return join(agentDir, "pi-terminology", "eval-ledger.json");
}

export function budgetTotals(ledger: Ledger): BudgetTotals {
  let jevReservedNanos = 0;
  let jevObservedNanos = 0;
  for (const attempt of ledger.attempts) {
    jevReservedNanos += attempt.reservedNanos;
    jevObservedNanos += attempt.observedNanos ?? 0;
  }
  return {
    attempts: ledger.attempts.length,
    jevReservedNanos,
    jevObservedNanos,
    otherCostNanos: ledger.otherCostNanos,
    overallNanos: jevReservedNanos + ledger.otherCostNanos,
  };
}

/** Pure check of whether `plannedAttempts` more requests fit, assuming each is reserved in full. */
export function previewBudget(ledger: Ledger, plannedAttempts: number): BudgetPreview {
  if (!isCount(plannedAttempts)) {
    throw new BudgetError("Planned attempts must be a nonnegative integer.");
  }
  const totals = budgetTotals(ledger);
  const plannedReserveNanos = plannedAttempts * ATTEMPT_RESERVATION_NANOS;
  const projectedJevNanos = totals.jevReservedNanos + plannedReserveNanos;
  const projectedOverallNanos = totals.overallNanos + plannedReserveNanos;
  return {
    ...totals,
    plannedAttempts,
    plannedReserveNanos,
    projectedJevNanos,
    projectedOverallNanos,
    jevRemainingNanos: JEV_CAP_NANOS - projectedJevNanos,
    overallRemainingNanos: OVERALL_CAP_NANOS - projectedOverallNanos,
    fits: projectedJevNanos <= JEV_CAP_NANOS && projectedOverallNanos <= OVERALL_CAP_NANOS,
  };
}

/** Validates a result's usage. Input must be a positive integer within the request limit. */
export function observeUsage(usage: unknown): UsageObservation {
  if (!isRecord(usage)) {
    throw new BudgetError("The response reported no usage.");
  }
  const { input, output, cost } = usage;
  if (!isCount(input) || input < 1 || input > MAX_REQUEST_INPUT_TOKENS) {
    throw new BudgetError("Input tokens must be a positive integer within the request limit.");
  }
  if (!isCount(output)) {
    throw new BudgetError("Output tokens must be a nonnegative integer.");
  }
  return {
    inputTokens: input,
    outputTokens: output,
    observedNanos: input * INPUT_NANOS_PER_TOKEN,
    nativeCostUsd: nativeCost(cost),
  };
}

function nativeCost(cost: unknown): number | null {
  if (cost === undefined) {
    return null;
  }
  const total = isRecord(cost) ? cost.total : undefined;
  if (!isFiniteNonNegative(total)) {
    throw new BudgetError("Reported cost must be a finite nonnegative number.");
  }
  return total;
}

/**
 * Takes exclusive ownership of the shared cumulative ledger. A second owner is refused rather
 * than waited for, and a lock left by a crashed run is never stolen: delete it by hand.
 */
export async function openLedger(
  path: string,
  now: () => Date = () => new Date(),
): Promise<LedgerSession> {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const lock = await acquireLock(lockPath);
  let closed = false;
  const release = async (): Promise<void> => {
    if (!closed) {
      closed = true;
      await lock.close();
      await rm(lockPath, { force: true });
    }
  };
  try {
    return createSession(path, await readLedger(path), now, release, () => closed);
  } catch (error: unknown) {
    await release();
    throw error;
  }
}

async function acquireLock(lockPath: string) {
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(`${process.pid}\n`);
    return handle;
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "EEXIST") {
      throw new BudgetError(
        `The budget ledger is locked by another run (${lockPath}). Remove it only if no run is active.`,
      );
    }
    throw error;
  }
}

function createSession(
  path: string,
  initial: Ledger,
  now: () => Date,
  release: () => Promise<void>,
  isClosed: () => boolean,
): LedgerSession {
  let ledger = initial;
  const commit = async (next: Ledger): Promise<void> => {
    await writeLedger(path, next);
    ledger = next;
  };
  const settle = async (recordId: string, update: Partial<AttemptRecord>) => {
    assertOpen(isClosed());
    const current = ledger.attempts.find((attempt) => attempt.recordId === recordId);
    if (current?.status !== "reserved") {
      throw new BudgetError(`Attempt ${recordId} has no open reservation.`);
    }
    const settled = { ...current, ...update };
    await commit({
      ...ledger,
      attempts: ledger.attempts.map((attempt) => (attempt === current ? settled : attempt)),
    });
    return settled;
  };
  const settleFailure = async (recordId: string) => settle(recordId, { status: "failed" });
  return {
    snapshot: () => ledger,
    close: release,
    settleFailure,
    reserve: async (recordId) => {
      assertOpen(isClosed());
      const record = newReservation(ledger, recordId, now());
      await commit({ ...ledger, attempts: [...ledger.attempts, record] });
      return record;
    },
    settleSuccess: async (recordId, usage) => {
      let observation: UsageObservation;
      try {
        observation = observeUsage(usage);
      } catch (error: unknown) {
        await settleFailure(recordId);
        throw error;
      }
      return settle(recordId, {
        status: "succeeded",
        inputTokens: observation.inputTokens,
        outputTokens: observation.outputTokens,
        observedNanos: observation.observedNanos,
        nativeCostUsd: observation.nativeCostUsd,
      });
    },
  };
}

function assertOpen(closed: boolean): void {
  if (closed) {
    throw new BudgetError("The budget ledger session is closed.");
  }
}

function newReservation(ledger: Ledger, recordId: string, at: Date): AttemptRecord {
  if (recordId === "") {
    throw new BudgetError("An attempt needs a record id.");
  }
  if (ledger.attempts.some((attempt) => attempt.recordId === recordId)) {
    throw new BudgetError(
      `Attempt ${recordId} is already recorded; every repeat is a new attempt.`,
    );
  }
  if (!previewBudget(ledger, 1).fits) {
    throw new BudgetError("The attempt's full reservation would exceed the budget; refusing.");
  }
  return {
    recordId,
    reservedNanos: ATTEMPT_RESERVATION_NANOS,
    status: "reserved",
    startedAt: at.toISOString(),
    inputTokens: null,
    outputTokens: null,
    observedNanos: null,
    nativeCostUsd: null,
  };
}

/** Writes through a temporary file so a crash never leaves a torn ledger. */
async function writeLedger(path: string, ledger: Ledger): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`);
  await rename(temporary, path);
}

export async function readLedger(path: string): Promise<Ledger> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") {
      return emptyLedger();
    }
    throw error;
  }
  return parseLedger(text);
}

export function parseLedger(text: string): Ledger {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw corrupt("not JSON");
  }
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw corrupt("unexpected shape");
  }
  const { otherCostNanos, attempts: rawAttempts } = value;
  if (!isCount(otherCostNanos) || !Array.isArray(rawAttempts)) {
    throw corrupt("invalid fields");
  }
  const attempts = rawAttempts.map((raw: unknown) => parseAttempt(raw));
  if (new Set(attempts.map((attempt) => attempt.recordId)).size !== attempts.length) {
    throw corrupt("duplicate record id");
  }
  return { schemaVersion: 1, otherCostNanos, attempts };
}

function parseAttempt(value: unknown): AttemptRecord {
  if (!isRecord(value)) {
    throw corrupt("attempt");
  }
  const { recordId, reservedNanos, status, startedAt } = value;
  const { inputTokens, outputTokens, observedNanos, nativeCostUsd } = value;
  if (
    typeof recordId !== "string" ||
    recordId === "" ||
    reservedNanos !== ATTEMPT_RESERVATION_NANOS ||
    (status !== "reserved" && status !== "succeeded" && status !== "failed") ||
    typeof startedAt !== "string" ||
    !isNullableCount(inputTokens) ||
    !isNullableCount(outputTokens) ||
    !isNullableCount(observedNanos) ||
    !(nativeCostUsd === null || isFiniteNonNegative(nativeCostUsd))
  ) {
    throw corrupt("attempt fields");
  }
  return {
    recordId,
    reservedNanos: ATTEMPT_RESERVATION_NANOS,
    status,
    startedAt,
    inputTokens,
    outputTokens,
    observedNanos,
    nativeCostUsd,
  };
}

function corrupt(detail: string): BudgetError {
  return new BudgetError(`The budget ledger is corrupt (${detail}); refusing to run.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableCount(value: unknown): value is number | null {
  return value === null || isCount(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
