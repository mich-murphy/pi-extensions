import { OUTSIDE_OWNERS, THRESHOLDS } from "./jev.ts";
import type { LedgerEvent, OwnerEvent, RecordEvent } from "./ledger.ts";
import { UNATTRIBUTED } from "./owner.ts";

const MCP_TOOL = /mcp__/u;

export type ReportEvent = Extract<RecordEvent, { readonly type: "report" }>;

export function asksOwner(record: RecordEvent): record is ReportEvent {
  return (
    record.type === "report" &&
    record.owner === UNATTRIBUTED &&
    record.evidence === undefined &&
    !MCP_TOOL.test([record.component, record.summary, record.expected, record.actual].join("\n"))
  );
}

function acceptedOwner(answer: OwnerEvent): string | undefined {
  return answer.confidence >= THRESHOLDS.owner && !Object.hasOwn(OUTSIDE_OWNERS, answer.owner)
    ? answer.owner
    : undefined;
}

function preferred(candidate: OwnerEvent, kept: OwnerEvent): boolean {
  return (
    candidate.confidence > kept.confidence ||
    (candidate.confidence === kept.confidence &&
      (candidate.owner < kept.owner || (candidate.owner === kept.owner && candidate.id < kept.id)))
  );
}

export type AnsweredOwners = {
  readonly events: ReadonlyArray<LedgerEvent>;
  readonly moved: ReadonlyMap<string, string>;
};

export function withAnsweredOwners(events: ReadonlyArray<LedgerEvent>): AnsweredOwners {
  const answers = new Map<string, OwnerEvent>();

  for (const event of events) {
    if (event.type !== "owner" || acceptedOwner(event) === undefined) {
      continue;
    }

    const kept = answers.get(event.fingerprint);

    if (kept === undefined || preferred(event, kept)) {
      answers.set(event.fingerprint, event);
    }
  }

  const moved = new Map<string, string>();

  const answered = events.map((event) => {
    if (event.type !== "report" || !asksOwner(event)) {
      return event;
    }

    const answer = answers.get(event.fingerprint);

    if (answer === undefined) {
      return event;
    }

    moved.set(event.fingerprint, answer.owner);

    return { ...event, owner: answer.owner };
  });

  return { events: answered, moved };
}
