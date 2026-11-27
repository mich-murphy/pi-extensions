import type { RecordEvent } from "./ledger.ts";
import { UNATTRIBUTED } from "./owner.ts";

const PI_CORE_MIN_SESSIONS = 2;

const NETWORK_TOOLS: ReadonlySet<string> = new Set(["webfetch", "websearch"]);

const OUTSIDE_FAILURE =
  /Request failed \(\d{3}\b|Connection (?:refused|reset) by|Could not resolve host|TLS certificate error for|timed out|rate.?limit|too many requests|HTTP 5\d{2}\b|\b429\b|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/iu;

const ALL_PROVIDERS_FAILED = /^All search providers failed \((?<attempts>.*)\)\.?$/su;

export type PiCoreCandidate = {
  readonly owner: string;
  readonly live: ReadonlyArray<RecordEvent>;
  readonly excluded: ReadonlyArray<RecordEvent>;
  readonly sessions: number;
};

function isBatchOrdered(record: RecordEvent): boolean {
  return record.type === "signal" && record.cause === "parallel-batch";
}

function isOutsideText(text: string): boolean {
  const attempts = ALL_PROVIDERS_FAILED.exec(text.trim())?.groups?.attempts;

  return attempts === undefined
    ? OUTSIDE_FAILURE.test(text)
    : attempts.split("; ").every((attempt) => OUTSIDE_FAILURE.test(attempt));
}

export function isOutsideService(record: RecordEvent): boolean {
  return record.type === "signal" && NETWORK_TOOLS.has(record.tool) && isOutsideText(record.error);
}

export function isExcluded(record: RecordEvent): boolean {
  return isBatchOrdered(record) || isOutsideService(record);
}

export function isPiCore(candidate: PiCoreCandidate): boolean {
  const { live, excluded } = candidate;

  return (
    candidate.owner === UNATTRIBUTED &&
    live.length > 0 &&
    live.every((record) => record.evidence === "pi-path" && record.pathExisted === true) &&
    ![...live, ...excluded].some((record) => isExcluded(record)) &&
    candidate.sessions >= PI_CORE_MIN_SESSIONS
  );
}
