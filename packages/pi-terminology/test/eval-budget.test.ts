import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ATTEMPT_RESERVATION_NANOS,
  BudgetError,
  JEV_CAP_NANOS,
  budgetTotals,
  emptyLedger,
  ledgerPathFor,
  observeUsage,
  openLedger,
  parseLedger,
  previewBudget,
} from "../eval-budget";
import type { Ledger } from "../eval-budget";

const ZERO_COST = { total: 0 };
const usage = (input: number, output = 1, cost: unknown = ZERO_COST) => ({
  input,
  output,
  cost,
});

describe("constants and preview", () => {
  test("reserves the full request at the documented tariff", () => {
    expect(ATTEMPT_RESERVATION_NANOS).toBe(2_752_512);
    expect(Math.floor(JEV_CAP_NANOS / ATTEMPT_RESERVATION_NANOS)).toBe(363);
  });

  test("previews whether planned attempts fit", () => {
    const preview = previewBudget(emptyLedger(), 363);
    expect(preview.fits).toBe(true);
    expect(preview.plannedReserveNanos).toBe(363 * ATTEMPT_RESERVATION_NANOS);
    expect(previewBudget(emptyLedger(), 364).fits).toBe(false);
    expect(previewBudget(emptyLedger(), 0).fits).toBe(true);
  });

  test("round two keeps all 108 original reservations while allowing 200 additional attempts", () => {
    const attempts = Array.from({ length: 108 }, (_, index) => ({
      recordId: `legacy/${String(index)}`,
      reservedNanos: ATTEMPT_RESERVATION_NANOS,
      status: "failed" as const,
      startedAt: "2026-10-14T00:00:00Z",
      inputTokens: null,
      outputTokens: null,
      observedNanos: null,
      nativeCostUsd: null,
    }));
    const preview = previewBudget({ ...emptyLedger(), attempts }, 200);
    expect(preview.jevReservedNanos).toBe(297_271_296);
    expect(preview.plannedReserveNanos).toBe(550_502_400);
    expect(preview.projectedJevNanos).toBe(847_773_696);
    expect(preview.projectedOverallNanos).toBe(847_773_696);
    expect(preview.fits).toBe(true);
  });

  test("other recorded cost counts toward the overall cap only", () => {
    const ledger: Ledger = { ...emptyLedger(), otherCostNanos: 4_900_000_000 };
    expect(previewBudget(ledger, 40).fits).toBe(false);
    expect(previewBudget(ledger, 1).fits).toBe(true);
    expect(budgetTotals(ledger).overallNanos).toBe(4_900_000_000);
  });

  test.each([-1, 1.5, Number.NaN])("rejects planned attempts %s", (planned) => {
    expect(() => previewBudget(emptyLedger(), planned)).toThrow(BudgetError);
  });
});

describe("observeUsage", () => {
  test("prices observed input and keeps native cost separate", () => {
    expect(observeUsage(usage(1000, 3, { total: 0 }))).toStrictEqual({
      inputTokens: 1000,
      outputTokens: 3,
      observedNanos: 42_000,
      nativeCostUsd: 0,
    });
    expect(observeUsage({ input: 5, output: 0 }).nativeCostUsd).toBeNull();
  });

  test.each([
    [undefined],
    [null],
    [[]],
    [usage(0)],
    [usage(65_537)],
    [usage(1.5)],
    [usage(Number.NaN)],
    [usage(10, -1)],
    [usage(10, 1.5)],
    [usage(10, 1, { total: -1 })],
    [usage(10, 1, { total: Number.POSITIVE_INFINITY })],
    [usage(10, 1, 5)],
  ])("rejects invalid usage %#", (value) => {
    expect(() => observeUsage(value)).toThrow(BudgetError);
  });

  test("accepts the request limit", () => {
    expect(observeUsage(usage(65_536)).observedNanos).toBe(ATTEMPT_RESERVATION_NANOS);
  });
});

describe("persistent ledger", () => {
  let dir = "";
  let path = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "eval-budget-"));
    path = ledgerPathFor(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("persists the reservation before settlement and accumulates across sessions", async () => {
    const first = await openLedger(path);
    await first.reserve("r1");
    const onDisk = parseLedger(await readFile(path, "utf8"));
    expect(onDisk.attempts).toHaveLength(1);
    expect(onDisk.attempts[0]).toMatchObject({ status: "reserved", reservedNanos: 2_752_512 });
    const settled = await first.settleSuccess("r1", usage(100, 2));
    expect(settled).toMatchObject({ status: "succeeded", observedNanos: 4200, inputTokens: 100 });
    await first.close();

    const second = await openLedger(path);
    await second.reserve("r2");
    await second.settleFailure("r2");
    const totals = budgetTotals(second.snapshot());
    await second.close();
    expect(totals).toMatchObject({
      attempts: 2,
      jevReservedNanos: 2 * ATTEMPT_RESERVATION_NANOS,
      jevObservedNanos: 4200,
    });
  });

  test("a failed attempt keeps its full reservation", async () => {
    const session = await openLedger(path);
    await session.reserve("r1");
    await session.settleFailure("r1");
    await session.close();
    const ledger = parseLedger(await readFile(path, "utf8"));
    expect(ledger.attempts[0]).toMatchObject({ status: "failed", observedNanos: null });
    expect(budgetTotals(ledger).jevReservedNanos).toBe(ATTEMPT_RESERVATION_NANOS);
  });

  test("invalid usage fails the attempt, keeps the reservation and throws", async () => {
    const session = await openLedger(path);
    await session.reserve("r1");
    await expect(session.settleSuccess("r1", undefined)).rejects.toThrow(BudgetError);
    expect(session.snapshot().attempts[0]?.status).toBe("failed");
    expect(budgetTotals(session.snapshot()).jevReservedNanos).toBe(ATTEMPT_RESERVATION_NANOS);
    await session.close();
  });

  test("refuses duplicates, empty ids and unreserved settlement", async () => {
    const session = await openLedger(path);
    await session.reserve("r1");
    await expect(session.reserve("r1")).rejects.toThrow("already recorded");
    await expect(session.reserve("")).rejects.toThrow("record id");
    await expect(session.settleFailure("nope")).rejects.toThrow("no open reservation");
    await session.settleFailure("r1");
    await expect(session.settleFailure("r1")).rejects.toThrow("no open reservation");
    await session.close();
  });

  test("refuses a reservation that would exceed the cap before it is recorded", async () => {
    const attempts = Array.from({ length: 363 }, (_, index) => ({
      recordId: `old-${String(index)}`,
      reservedNanos: ATTEMPT_RESERVATION_NANOS,
      status: "failed" as const,
      startedAt: "2026-10-14T00:00:00.000Z",
      inputTokens: null,
      outputTokens: null,
      observedNanos: null,
      nativeCostUsd: null,
    }));
    const full: Ledger = { ...emptyLedger(), attempts };
    const session = await openLedger(path);
    await session.close();
    await writeFile(path, JSON.stringify(full));
    const reopened = await openLedger(path);
    await expect(reopened.reserve("over")).rejects.toThrow("exceed the budget");
    expect(reopened.snapshot().attempts).toHaveLength(363);
    await reopened.close();
    expect(parseLedger(await readFile(path, "utf8")).attempts).toHaveLength(363);
  });

  test("a second owner is refused until the first closes", async () => {
    const first = await openLedger(path);
    await expect(openLedger(path)).rejects.toThrow("locked");
    await first.close();
    await first.close();
    await expect(first.reserve("late")).rejects.toThrow("closed");
    const second = await openLedger(path);
    await second.close();
    await expect(access(`${path}.lock`)).rejects.toThrow("ENOENT");
  });

  test("a corrupt ledger is refused and releases the lock", async () => {
    const session = await openLedger(path);
    await session.close();
    await writeFile(path, "{not json");
    await expect(openLedger(path)).rejects.toThrow("corrupt");
    await expect(access(`${path}.lock`)).rejects.toThrow("ENOENT");
  });
});

const wrap = (attempts: unknown[], extra: object = {}) =>
  JSON.stringify({ schemaVersion: 1, otherCostNanos: 0, attempts, ...extra });

describe("parseLedger", () => {
  const good = {
    recordId: "r",
    reservedNanos: ATTEMPT_RESERVATION_NANOS,
    status: "reserved",
    startedAt: "t",
    inputTokens: null,
    outputTokens: null,
    observedNanos: null,
    nativeCostUsd: null,
  };

  test("round-trips a valid ledger", () => {
    expect(parseLedger(wrap([good])).attempts).toStrictEqual([good]);
  });

  test.each([
    ["[]"],
    [JSON.stringify({ schemaVersion: 2 })],
    [wrap([], { otherCostNanos: -1 })],
    [wrap([], { attempts: "x" })],
    [wrap([5])],
    [wrap([good, good])],
    [wrap([{ ...good, reservedNanos: 1 }])],
    [wrap([{ ...good, status: "done" }])],
    [wrap([{ ...good, recordId: "" }])],
    [wrap([{ ...good, inputTokens: -2 }])],
    [wrap([{ ...good, nativeCostUsd: -1 }])],
  ])("rejects corrupt ledger %#", (text) => {
    expect(() => parseLedger(text)).toThrow("corrupt");
  });
});
