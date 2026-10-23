import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ATTEMPT_RESERVATION_NANOS, emptyLedger, previewBudget } from "../eval-budget";
import {
  openRecallLedger,
  previewRecallBudget,
  readRecallLedger,
  RECALL_CAP_NANOS,
  RECALL_PLANNED_ATTEMPTS,
} from "../recall-budget";

const dirs: string[] = [];
async function path() {
  const dir = await mkdtemp(join(tmpdir(), "recall-budget-"));
  dirs.push(dir);
  return join(dir, "ledger.json");
}

describe("isolated fresh recall authorization", () => {
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("fits all 1786 calls under $5 without changing historical $1 gate", () => {
    expect(previewRecallBudget(emptyLedger(), RECALL_PLANNED_ATTEMPTS)).toMatchObject({
      fits: true,
      projectedNanos: 4_915_986_432,
    });
    expect(RECALL_CAP_NANOS).toBe(5e9);
    expect(previewBudget(emptyLedger(), RECALL_PLANNED_ATTEMPTS).fits).toBe(false);
    expect(previewRecallBudget(emptyLedger(), 1800).fits).toBe(true);
    expect(previewRecallBudget(emptyLedger(), 1801).fits).toBe(false);
    expect(previewRecallBudget({ ...emptyLedger(), otherCostNanos: 5e9 }, 1).fits).toBe(false);
    for (const n of [-1, 1.5, Number.NaN, Infinity]) {
      expect(() => previewRecallBudget(emptyLedger(), n)).toThrow(Error);
    }
  });
  test("persists reservation before returning; exclusive ownership, private modes, retained crash reservation", async () => {
    const p = await path();
    const ledger = await openRecallLedger(p);
    await expect(openRecallLedger(p)).rejects.toThrow(Error);
    await ledger.reserve("pilot/a/0");
    const persisted = await readRecallLedger(p);
    expect(persisted.attempts[0]).toMatchObject({
      status: "reserved",
      reservedNanos: ATTEMPT_RESERVATION_NANOS,
    });
    const fileStat = await stat(p);
    const dirStat = await stat(join(p, ".."));
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(dirStat.mode & 0o777).toBe(0o700);
    await expect(ledger.reserve("pilot/a/0")).rejects.toThrow(Error);
    await ledger.close();
    const next = await openRecallLedger(p);
    await expect(next.reserve("pilot/a/0")).rejects.toThrow(Error);
    expect(next.snapshot().attempts).toHaveLength(1);
    await next.close();
    await expect(next.reserve("closed")).rejects.toThrow(Error);
  });
  test("invalid usage burns retained reservation and never permits duplicate settlement/replay", async () => {
    const p = await path();
    const l = await openRecallLedger(p);
    await l.reserve("bad");
    await expect(l.settleSuccess("bad", { input: 0, output: 0 })).rejects.toThrow(Error);
    expect(l.snapshot().attempts[0]?.status).toBe("failed");
    await expect(l.settleFailure("bad")).rejects.toThrow(Error);
    await l.reserve("ok");
    await l.settleSuccess("ok", { input: 100, output: 0, cost: { total: 0 } });
    expect(l.snapshot().attempts[1]).toMatchObject({
      status: "succeeded",
      observedNanos: 4200,
      reservedNanos: ATTEMPT_RESERVATION_NANOS,
    });
    const snapshot = l.snapshot();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberate caller mutation proves snapshots are defensive copies.
    (snapshot.attempts as unknown[]).pop();
    expect(l.snapshot().attempts).toHaveLength(2);
    await l.close();
    const finalLedger = await readRecallLedger(p);
    expect(finalLedger.attempts).toHaveLength(2);
  });
  test("refuses overlapping in-session transactions rather than losing reservations", async () => {
    const l = await openRecallLedger(await path());
    const a = l.reserve("a");
    await expect(l.reserve("b")).rejects.toThrow(/concurrent/u);
    await a;
    expect(l.snapshot().attempts.map((x) => x.recordId)).toStrictEqual(["a"]);
    await l.close();
  });
});
