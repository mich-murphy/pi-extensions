import type { Types } from "effect";
import type { Clock, LedgerEvent } from "../ledger.ts";

function eventId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function eventAt(n: number): string {
  return new Date(Date.UTC(2026, 10, 25, 0, 0, 0, n)).toISOString();
}

export function fakeClock(start = 1): Clock {
  let next = start;
  let tick = start;

  return {
    id: () => eventId(next++),
    now: () => new Date(eventAt(tick++)),
  };
}

export type SignalOptions = {
  readonly n: number;
  readonly session: string;
  readonly owner?: string;
  readonly fingerprint?: string;
  readonly error?: string;
  readonly evidence?: "pi-path";
  readonly cause?: "parallel-batch";
};

export function signal({
  n,
  session,
  owner = "pi-claude",
  fingerprint = "read: ENOENT",
  error = "ENOENT: no such file",
  evidence,
  cause,
}: SignalOptions): LedgerEvent {
  type Signal = Extract<LedgerEvent, { type: "signal" }>;

  const event: Types.Mutable<Signal> = {
    type: "signal",
    id: eventId(n),
    at: eventAt(n),
    session,
    owner,
    fingerprint,
    tool: "read",
    error,
  };

  if (evidence !== undefined) {
    event.evidence = evidence;
  }

  if (cause !== undefined) {
    event.cause = cause;
  }

  return event;
}

export type VerdictScores = {
  readonly harnessPath: number;
  readonly pathExisted: number;
  readonly outsideService: number;
};

export function verdictEvent(n: number, fingerprint: string, scores: VerdictScores): LedgerEvent {
  return {
    type: "verdict",
    id: eventId(n),
    at: eventAt(n),
    fingerprint,
    model: "typesafe/jev-1.14.0",
    ...scores,
  };
}

export type ReportOptions = SignalOptions & { readonly impact?: "blocked" | "slowed" };

export function report({
  n,
  session,
  owner = "pi-claude",
  fingerprint = "pi-claude/workaround",
  impact = "slowed",
}: ReportOptions): LedgerEvent {
  return {
    type: "report",
    id: eventId(n),
    at: eventAt(n),
    session,
    owner,
    fingerprint,
    kind: "workaround",
    component: "pi-claude",
    summary: "Scratch path changed between turns",
    expected: "One scratch path per session",
    actual: "A new path each turn",
    impact,
  };
}

export function resolveEvent(n: number, group: string): LedgerEvent {
  return {
    type: "resolve",
    id: eventId(n),
    at: eventAt(n),
    group,
    commit: "abc1234",
    layer: "architecture",
  };
}

export function reopenEvent(n: number, group: string): LedgerEvent {
  return { type: "reopen", id: eventId(n), at: eventAt(n), group, reason: "Seen again" };
}
