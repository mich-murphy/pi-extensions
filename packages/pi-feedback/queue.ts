import { groupId } from "./fingerprint.ts";
import type { LedgerEvent, RecordEvent, VerdictEvent } from "./ledger.ts";
import { PI_CORE, UNATTRIBUTED } from "./owner.ts";
import { isExcluded, isPiCore } from "./verdict.ts";

const NOT_FIXED_HERE: ReadonlySet<string> = new Set([PI_CORE, UNATTRIBUTED]);
const MIN_SESSIONS = 2;
const EXAMPLE_LIMIT = 80;

export type GroupStatus = "open" | "resolved" | "reopened";

export type Resolution = { readonly commit: string; readonly layer: string; readonly at: string };

export type Group = {
  readonly id: string;
  readonly owner: string;
  readonly fingerprint: string;
  readonly status: GroupStatus;
  readonly records: number;
  readonly excluded: number;
  readonly sessions: number;
  readonly piCore: boolean;
  readonly blocked: boolean;
  readonly lastAt: string;
  readonly example: string;
  readonly ready: boolean;
  readonly rank: number;
  readonly resolution: Resolution | undefined;
};

type Builder = {
  readonly id: string;
  readonly owner: string;
  readonly fingerprint: string;
  status: GroupStatus;
  live: RecordEvent[];
  resolution: Resolution | undefined;
};

const order = (a: string, b: string): number => Number(a > b) - Number(a < b);

function canonical(events: readonly LedgerEvent[]): readonly LedgerEvent[] {
  const byId = new Map<string, LedgerEvent>();
  for (const event of events) {
    const kept = byId.get(event.id);
    if (kept === undefined || JSON.stringify(event) < JSON.stringify(kept)) {
      byId.set(event.id, event);
    }
  }
  return [...byId.values()].toSorted((a, b) => order(a.at, b.at) || order(a.id, b.id));
}

function addRecord(builders: Map<string, Builder>, event: RecordEvent): void {
  const id = groupId(event.owner, event.fingerprint);
  const builder = builders.get(id) ?? {
    id,
    owner: event.owner,
    fingerprint: event.fingerprint,
    status: "open",
    live: [],
    resolution: undefined,
  };
  if (builder.status === "resolved") {
    builder.status = "reopened";
  }
  builder.live.push(event);
  builders.set(id, builder);
}

function apply(
  builders: Map<string, Builder>,
  verdicts: Map<string, VerdictEvent>,
  event: LedgerEvent,
): void {
  if (event.type === "report" || event.type === "signal") {
    addRecord(builders, event);
    return;
  }
  if (event.type === "verdict") {
    verdicts.set(event.fingerprint, event);
    return;
  }
  const builder = builders.get(event.group);
  if (builder === undefined) {
    return;
  }
  if (event.type === "resolve") {
    builder.status = "resolved";
    builder.resolution = { commit: event.commit, layer: event.layer, at: event.at };
    builder.live = [];
  } else if (builder.status === "resolved") {
    builder.status = "reopened";
  }
}

function exampleOf(event: RecordEvent): string {
  const text = (event.type === "report" ? event.summary : event.error)
    .replaceAll(/\s+/gu, " ")
    .trim();
  return text.length > EXAMPLE_LIMIT ? `${text.slice(0, EXAMPLE_LIMIT - 1)}…` : text;
}

function finish(builder: Builder, verdict: VerdictEvent | undefined): Group {
  const { status } = builder;
  const live = builder.live.filter((event) => !isExcluded(event, verdict));
  const excluded = builder.live.filter((event) => isExcluded(event, verdict));
  const sessions = new Set(live.map((event) => event.session)).size;
  const blocked = live.some((event) => event.type === "report" && event.impact === "blocked");
  const latest = live.at(-1);
  const open = status !== "resolved";
  const piCore = isPiCore({ owner: builder.owner, live, excluded, sessions, verdict });
  return {
    id: builder.id,
    owner: builder.owner,
    fingerprint: builder.fingerprint,
    status,
    records: live.length,
    excluded: excluded.length,
    sessions,
    piCore,
    blocked,
    lastAt: latest?.at ?? builder.resolution?.at ?? "",
    example: latest === undefined ? "" : exampleOf(latest),
    ready: open && !NOT_FIXED_HERE.has(builder.owner) && sessions >= MIN_SESSIONS,
    rank: open ? sessions * live.length * (blocked ? 2 : 1) : 0,
    resolution: builder.resolution,
  };
}

function byPriority(a: Group, b: Group): number {
  return (
    Number(b.ready) - Number(a.ready) ||
    b.rank - a.rank ||
    order(b.lastAt, a.lastAt) ||
    order(a.id, b.id)
  );
}

export function deriveGroups(events: readonly LedgerEvent[]): readonly Group[] {
  const builders = new Map<string, Builder>();
  const verdicts = new Map<string, VerdictEvent>();
  for (const event of canonical(events)) {
    apply(builders, verdicts, event);
  }
  return [...builders.values()]
    .map((builder) => finish(builder, verdicts.get(builder.fingerprint)))
    .toSorted(byPriority);
}
