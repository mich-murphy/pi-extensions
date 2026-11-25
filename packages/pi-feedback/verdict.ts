import { THRESHOLDS } from "./jev.ts";
import type { RecordEvent, VerdictEvent } from "./ledger.ts";
import { UNATTRIBUTED } from "./owner.ts";

const PI_CORE_MIN_SESSIONS = 2;

export type PiCoreCandidate = {
  readonly owner: string;
  readonly live: readonly RecordEvent[];
  readonly excluded: readonly RecordEvent[];
  readonly sessions: number;
  readonly verdicts: readonly (VerdictEvent | undefined)[];
};

function isBatchOrdered(record: RecordEvent): boolean {
  return record.type === "signal" && record.cause === "parallel-batch";
}

export function isExcluded(record: RecordEvent, verdict: VerdictEvent | undefined): boolean {
  return (
    isBatchOrdered(record) ||
    (verdict !== undefined && verdict.outsideService >= THRESHOLDS.excludedOutsideFrom)
  );
}

function verdictPasses(verdict: VerdictEvent | undefined): boolean {
  return (
    verdict !== undefined &&
    verdict.harnessPath >= THRESHOLDS.harnessPath &&
    verdict.pathExisted >= THRESHOLDS.pathExisted &&
    verdict.outsideService < THRESHOLDS.piCoreOutsideBelow
  );
}

export function isPiCore(candidate: PiCoreCandidate): boolean {
  const { live, excluded } = candidate;
  return (
    candidate.owner === UNATTRIBUTED &&
    live.length > 0 &&
    live.every((record) => record.evidence === "pi-path") &&
    ![...live, ...excluded].some((record) => isBatchOrdered(record)) &&
    candidate.sessions >= PI_CORE_MIN_SESSIONS &&
    candidate.verdicts.length > 0 &&
    candidate.verdicts.every((verdict) => verdictPasses(verdict))
  );
}
