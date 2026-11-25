import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Option, Schema } from "effect";
import { redact } from "./redact.ts";

export const FIELD_LIMIT = 2000;

export const KINDS = [
  "tool_error",
  "confusing_instruction",
  "missing_capability",
  "unexpected_behavior",
  "workaround",
] as const;

export const LAYERS = ["architecture", "types", "lint", "test", "docs"] as const;

export const IMPACTS = ["blocked", "slowed"] as const;

const matching = (pattern: RegExp) => Schema.String.pipe(Schema.check(Schema.isPattern(pattern)));
const Text = Schema.String.pipe(Schema.check(Schema.isMaxLength(FIELD_LIMIT)));
const Line = Schema.String.pipe(Schema.check(Schema.isNonEmpty(), Schema.isMaxLength(FIELD_LIMIT)));

const stamp = {
  id: matching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
  at: matching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
};

const Owner = matching(/^[a-z0-9][a-z0-9-]{0,63}$/u);

const recorded = {
  ...stamp,
  session: Line,
  owner: Owner,
  fingerprint: Line,
  model: Schema.optionalKey(Line),
  piVersion: Schema.optionalKey(Line),
  evidence: Schema.optionalKey(Schema.Literal("pi-path")),
};

const Score = Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 })));

const GroupId = matching(/^[0-9a-f]{12}$/u);

const ReportEvent = Schema.Struct({
  type: Schema.Literal("report"),
  ...recorded,
  kind: Schema.Literals(KINDS),
  component: Line,
  summary: Line,
  expected: Text,
  actual: Line,
  workaround: Schema.optionalKey(Text),
  impact: Schema.Literals(IMPACTS),
});

const SignalEvent = Schema.Struct({
  type: Schema.Literal("signal"),
  ...recorded,
  tool: matching(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u),
  error: Text,
  cause: Schema.optionalKey(Schema.Literal("parallel-batch")),
});

const VerdictEvent = Schema.Struct({
  type: Schema.Literal("verdict"),
  ...stamp,
  fingerprint: Line,
  model: Line,
  harnessPath: Score,
  pathExisted: Score,
  outsideService: Score,
});

const SameCauseEvent = Schema.Struct({
  type: Schema.Literal("same_cause"),
  ...stamp,
  owner: Owner,
  a: Line,
  b: Line,
  model: Line,
  sameCause: Score,
});

const ResolveEvent = Schema.Struct({
  type: Schema.Literal("resolve"),
  ...stamp,
  group: GroupId,
  commit: matching(/^[0-9a-f]{7,40}$/u),
  layer: Schema.Literals(LAYERS),
});

const ReopenEvent = Schema.Struct({
  type: Schema.Literal("reopen"),
  ...stamp,
  group: GroupId,
  reason: Line,
});

const LedgerEvent = Schema.Union([
  ReportEvent,
  SignalEvent,
  VerdictEvent,
  SameCauseEvent,
  ResolveEvent,
  ReopenEvent,
]);

export type LedgerEvent = typeof LedgerEvent.Type;
export type RecordEvent = Extract<LedgerEvent, { readonly type: "report" | "signal" }>;
export type VerdictEvent = Extract<LedgerEvent, { readonly type: "verdict" }>;
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventDraft = DistributiveOmit<LedgerEvent, "id" | "at">;
export type LedgerRead = { readonly events: readonly LedgerEvent[]; readonly skipped: number };
export type Clock = { readonly now: () => Date; readonly id: () => string };

const systemClock: Clock = { now: () => new Date(), id: randomUUID };
const decodeEvent = Schema.decodeUnknownOption(LedgerEvent);
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(LedgerEvent));

export function ledgerPath(agentDir: string): string {
  return join(agentDir, "harness-feedback", "ledger.jsonl");
}

function clip(text: string): string {
  return text.length > FIELD_LIMIT ? `${text.slice(0, FIELD_LIMIT - 1)}…` : text;
}

function clean(value: unknown): unknown {
  return typeof value === "string" ? clip(redact(value)) : value;
}

export async function appendEvent(
  file: string,
  draft: EventDraft,
  clock: Clock = systemClock,
): Promise<LedgerEvent> {
  const stamped = { ...draft, id: clock.id(), at: clock.now().toISOString() };
  const cleaned = Object.fromEntries(
    Object.entries(stamped).map(([key, value]) => [key, clean(value)]),
  );
  const event = Option.getOrUndefined(decodeEvent(cleaned));
  if (event === undefined) {
    throw new TypeError(`Not a valid ${draft.type} event for the feedback ledger.`);
  }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return event;
}

export function parseLedger(text: string): LedgerRead {
  const events: LedgerEvent[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const event = Option.getOrUndefined(decodeLine(line));
    if (event === undefined) {
      skipped += 1;
    } else {
      events.push(event);
    }
  }
  return { events, skipped };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function readLedger(file: string): Promise<LedgerRead> {
  try {
    return parseLedger(await readFile(file, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) {
      return { events: [], skipped: 0 };
    }
    throw error;
  }
}
