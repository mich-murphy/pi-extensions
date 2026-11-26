import { groupId } from "./fingerprint.ts";
import { THRESHOLDS } from "./jev.ts";
import type { LedgerEvent, RecordEvent, VerdictEvent } from "./ledger.ts";
import { withAnsweredOwners } from "./owner-answer.ts";
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
  readonly fingerprints: ReadonlyArray<string>;
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
  readonly fingerprints: Set<string>;
  status: GroupStatus;
  live: Array<RecordEvent>;
  resolution: Resolution | undefined;
};

type Merges = {
  readonly rootOf: (owner: string, fingerprint: string) => string;
  readonly aliases: ReadonlyMap<string, string>;
};

const order = (a: string, b: string): number => Number(a > b) - Number(a < b);

function canonical(events: ReadonlyArray<LedgerEvent>): ReadonlyArray<LedgerEvent> {
  const byId = new Map<string, LedgerEvent>();

  for (const event of events) {
    const kept = byId.get(event.id);

    if (kept === undefined || JSON.stringify(event) < JSON.stringify(kept)) {
      byId.set(event.id, event);
    }
  }

  return [...byId.values()].toSorted((a, b) => order(a.at, b.at) || order(a.id, b.id));
}

function isRecord(event: LedgerEvent): event is RecordEvent {
  return event.type === "report" || event.type === "signal";
}

function memberKey(owner: string, fingerprint: string): string {
  return JSON.stringify([owner, fingerprint]);
}

function mergesOf(events: ReadonlyArray<LedgerEvent>): Merges {
  const firstAt = new Map<string, string>();
  const fingerprintOf = new Map<string, readonly [string, string]>();

  const remember = (owner: string, fingerprint: string): string => {
    const key = memberKey(owner, fingerprint);
    fingerprintOf.set(key, [owner, fingerprint]);

    return key;
  };

  for (const event of events.filter((candidate) => isRecord(candidate))) {
    const key = remember(event.owner, event.fingerprint);

    if (!firstAt.has(key)) {
      firstAt.set(key, event.at);
    }
  }

  const parent = new Map<string, string>();

  const find = (key: string): string => {
    let current = key;

    for (let next = parent.get(current); next !== undefined; next = parent.get(current)) {
      current = next;
    }

    return current;
  };

  const precedence = (key: string): string => `${firstAt.get(key) ?? "~"}\n${key}`;

  for (const event of events) {
    if (event.type === "same_cause" && event.sameCause >= THRESHOLDS.sameCause) {
      const a = find(remember(event.owner, event.a));
      const b = find(remember(event.owner, event.b));
      const [root, child] = precedence(a) <= precedence(b) ? [a, b] : [b, a];

      if (root !== child) {
        parent.set(child, root);
      }
    }
  }

  const aliases = new Map<string, string>();

  for (const [key, [owner, fingerprint]] of fingerprintOf) {
    const root = fingerprintOf.get(find(key))?.[1] ?? fingerprint;
    aliases.set(groupId(owner, fingerprint), groupId(owner, root));
  }

  return {
    rootOf: (owner, fingerprint) =>
      fingerprintOf.get(find(memberKey(owner, fingerprint)))?.[1] ?? fingerprint,
    aliases,
  };
}

function addRecord(builders: Map<string, Builder>, merges: Merges, event: RecordEvent): void {
  const fingerprint = merges.rootOf(event.owner, event.fingerprint);
  const id = groupId(event.owner, fingerprint);

  const builder = builders.get(id) ?? {
    id,
    owner: event.owner,
    fingerprint,
    fingerprints: new Set<string>(),
    status: "open",
    live: [],
    resolution: undefined,
  };

  if (builder.status === "resolved") {
    builder.status = "reopened";
  }

  builder.fingerprints.add(event.fingerprint);
  builder.live.push(event);
  builders.set(id, builder);
}

function apply(
  builders: Map<string, Builder>,
  verdicts: Map<string, VerdictEvent>,
  merges: Merges,
  event: LedgerEvent,
): void {
  if (isRecord(event)) {
    addRecord(builders, merges, event);

    return;
  }

  if (event.type === "verdict") {
    verdicts.set(event.fingerprint, event);

    return;
  }

  if (event.type === "same_cause" || event.type === "owner") {
    return;
  }

  const builder = builders.get(merges.aliases.get(event.group) ?? event.group);

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

function finish(builder: Builder, verdicts: ReadonlyMap<string, VerdictEvent>): Group {
  const { status } = builder;

  const excludedHere = (event: RecordEvent): boolean =>
    isExcluded(event, verdicts.get(event.fingerprint));

  const live = builder.live.filter((event) => !excludedHere(event));
  const excluded = builder.live.filter((event) => excludedHere(event));
  const sessions = new Set(live.map((event) => event.session)).size;
  const blocked = live.some((event) => event.type === "report" && event.impact === "blocked");
  const latest = live.at(-1);
  const open = status !== "resolved";
  const fingerprints = [...builder.fingerprints].toSorted(order);

  const piCore = isPiCore({
    owner: builder.owner,
    live,
    excluded,
    sessions,
    verdicts: fingerprints.map((fingerprint) => verdicts.get(fingerprint)),
  });

  return {
    id: builder.id,
    owner: builder.owner,
    fingerprint: builder.fingerprint,
    fingerprints,
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

export function deriveGroups(events: ReadonlyArray<LedgerEvent>): ReadonlyArray<Group> {
  const ordered = withAnsweredOwners(canonical(events));
  const merges = mergesOf(ordered);
  const builders = new Map<string, Builder>();
  const verdicts = new Map<string, VerdictEvent>();

  for (const event of ordered) {
    apply(builders, verdicts, merges, event);
  }

  return [...builders.values()].map((builder) => finish(builder, verdicts)).toSorted(byPriority);
}
