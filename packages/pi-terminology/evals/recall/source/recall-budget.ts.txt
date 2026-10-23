import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ATTEMPT_RESERVATION_NANOS,
  BudgetError,
  budgetTotals,
  emptyLedger,
  observeUsage,
  parseLedger,
} from "./eval-budget";
import type { AttemptRecord, Ledger, LedgerSession } from "./eval-budget";

export const RECALL_CAP_NANOS = 5_000_000_000;
const RECALL_MAX_ATTEMPTS = 1800;
export const RECALL_PLANNED_ATTEMPTS = 1786;
export function previewRecallBudget(ledger: Ledger, plannedAttempts: number) {
  if (!Number.isSafeInteger(plannedAttempts) || plannedAttempts < 0) {
    throw new BudgetError("Invalid attempt count.");
  }
  const totals = budgetTotals(ledger);
  const projectedNanos = totals.overallNanos + plannedAttempts * ATTEMPT_RESERVATION_NANOS;
  return {
    ...totals,
    projectedNanos,
    fits:
      totals.attempts + plannedAttempts <= RECALL_MAX_ATTEMPTS &&
      projectedNanos <= RECALL_CAP_NANOS,
  };
}
/** Atomic replacement, file AND directory fsync. Never used for immutable receipts. */
async function writeRecallAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  const dir = await open(dirname(path), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
export async function writeRecallNew(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const dir = await open(dirname(path), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
export async function readRecallLedger(path: string): Promise<Ledger> {
  try {
    return parseLedger(await readFile(path, "utf8"));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return emptyLedger();
    }
    throw error;
  }
}
/** One serial owner; stale locks are deliberately never stolen. Reservations survive every failure. */
export async function openRecallLedger(
  path: string,
  now = () => new Date(),
): Promise<LedgerSession> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, "wx", 0o600);
  await lock.writeFile(`${process.pid}\n`);
  await lock.sync();
  let closed = false;
  let busy = false;
  const close = async () => {
    if (busy) {
      throw new BudgetError("Cannot close an active recall ledger transaction.");
    }
    if (!closed) {
      closed = true;
      await lock.close();
      await rm(lockPath);
    }
  };
  try {
    let ledger = await readRecallLedger(path);
    if (!previewRecallBudget(ledger, 0).fits) {
      throw new BudgetError("Existing recall ledger exceeds authorization.");
    }
    const transaction = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (closed || busy) {
        throw new BudgetError("Closed or concurrent recall ledger operation.");
      }
      busy = true;
      try {
        return await fn();
      } finally {
        busy = false;
      }
    };
    const commit = async (next: Ledger) => {
      await writeRecallAtomic(path, next);
      ledger = next;
    };
    const settle = async (id: string, patch: Partial<AttemptRecord>) => {
      const current = ledger.attempts.find((a) => a.recordId === id);
      if (current?.status !== "reserved") {
        throw new BudgetError("No open recall reservation.");
      }
      const next = { ...current, ...patch };
      await commit({ ...ledger, attempts: ledger.attempts.map((a) => (a === current ? next : a)) });
      return next;
    };
    return {
      close,
      snapshot: () => structuredClone(ledger),
      reserve: async (id) =>
        transaction(async () => {
          if (!id.trim() || ledger.attempts.some((a) => a.recordId === id)) {
            throw new BudgetError("Duplicate or empty recall attempt ID.");
          }
          if (!previewRecallBudget(ledger, 1).fits) {
            throw new BudgetError("Recall authorization exhausted.");
          }
          const next: AttemptRecord = {
            recordId: id,
            reservedNanos: ATTEMPT_RESERVATION_NANOS,
            status: "reserved",
            startedAt: now().toISOString(),
            inputTokens: null,
            outputTokens: null,
            observedNanos: null,
            nativeCostUsd: null,
          };
          await commit({ ...ledger, attempts: [...ledger.attempts, next] });
          return next;
        }),
      settleFailure: async (id) => transaction(async () => settle(id, { status: "failed" })),
      settleSuccess: async (id, usage) =>
        transaction(async () => {
          let observation;
          try {
            observation = observeUsage(usage);
          } catch (error) {
            await settle(id, { status: "failed" });
            throw error;
          }
          return settle(id, { status: "succeeded", ...observation });
        }),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Completion must never outlive the observation bytes it seals. */
export async function syncRecallEvidence(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/** Failures have no completion seal, so flush their bytes and directory entry immediately. */
export async function appendRecallFailure(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
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
