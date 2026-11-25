import type {
  ClassifierApi,
  ClassifierBoolQuestion,
  ClassifierContext,
  ClassifierModel,
  ClassifierResult,
  JsonObject,
} from "@earendil-works/pi-ai";
import { Data } from "effect";
import {
  ERROR_LIMIT,
  INPUT_LIMIT,
  JEV_CATALOG_ID,
  JEV_MODEL,
  JEV_MODEL_ID,
  JEV_PROVIDER,
  MAX_MERGE_COMPARISONS,
  RECORD_QUESTIONS,
  SAME_CAUSE_QUESTION,
  THRESHOLDS,
} from "./jev.ts";
import type { RecordQuestion } from "./jev.ts";
import { appendEvent, readLedger } from "./ledger.ts";
import type { Clock, LedgerEvent, RecordEvent, VerdictEvent } from "./ledger.ts";
import { UNATTRIBUTED } from "./owner.ts";
import { deriveGroups } from "./queue.ts";
import { redact } from "./redact.ts";

export type ClassifierRegistry = {
  readonly getProviderAuthStatus: (provider: string) => { readonly configured: boolean };
  readonly getModelOfType: (
    type: "classifier",
    provider: string,
    modelId: string,
  ) => ClassifierModel<ClassifierApi> | undefined;
  readonly classify: (
    model: ClassifierModel<ClassifierApi>,
    context: ClassifierContext,
  ) => Promise<ClassifierResult>;
};

export type ClassifyJob = {
  readonly registry: ClassifierRegistry;
  readonly ledger: string;
  readonly record: RecordEvent;
  readonly input?: JsonObject | undefined;
  readonly clock?: Clock | undefined;
};

export type ClassifyOutcome =
  | { readonly _tag: "unavailable" }
  | { readonly _tag: "skipped" }
  | { readonly _tag: "classified"; readonly calls: number; readonly failed: number };

export const ClassifyOutcome = Data.taggedEnum<ClassifyOutcome>();

type Scores = Pick<VerdictEvent, RecordQuestion>;

type Asker = (
  state: JsonObject,
  questions: Readonly<Record<string, ClassifierBoolQuestion>>,
) => Promise<ClassifierResult | undefined>;

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function probability(result: ClassifierResult | undefined, id: string): number | undefined {
  const answer = result?.answers[id];

  return answer?.type === "bool" ? answer.probability : undefined;
}

function scoresOf(result: ClassifierResult | undefined): Scores | undefined {
  const harnessPath = probability(result, "harnessPath");
  const pathExisted = probability(result, "pathExisted");
  const outsideService = probability(result, "outsideService");

  return harnessPath === undefined || pathExisted === undefined || outsideService === undefined
    ? undefined
    : { harnessPath, pathExisted, outsideService };
}

function sideOf(record: RecordEvent): JsonObject {
  return record.type === "signal"
    ? { tool: record.tool, error: clip(record.error, ERROR_LIMIT) }
    : { component: record.component, kind: record.kind, error: clip(record.actual, ERROR_LIMIT) };
}

function inputText(input: JsonObject | undefined): JsonObject {
  const text = input === undefined ? undefined : JSON.stringify(input);

  return text === undefined ? {} : { input: clip(redact(text), INPUT_LIMIT) };
}

function pairKey(a: string, b: string): string {
  return JSON.stringify([a, b]);
}

function needsClassifying(record: RecordEvent): boolean {
  const batchOrdered = record.type === "signal" && record.cause === "parallel-batch";

  return !batchOrdered && (record.owner !== UNATTRIBUTED || record.evidence === "pi-path");
}

async function verdictFor(
  job: ClassifyJob,
  events: readonly LedgerEvent[],
  ask: Asker,
): Promise<Scores | undefined> {
  const { record } = job;

  const stored = events.find(
    (event): event is VerdictEvent =>
      event.type === "verdict" && event.fingerprint === record.fingerprint,
  );

  if (stored !== undefined) {
    return stored;
  }

  const scores = scoresOf(
    await ask({ ...sideOf(record), ...inputText(job.input) }, RECORD_QUESTIONS),
  );

  if (scores !== undefined) {
    await appendEvent(
      job.ledger,
      { type: "verdict", fingerprint: record.fingerprint, model: JEV_MODEL, ...scores },
      job.clock,
    );
  }

  return scores;
}

function comparisonsFor(record: RecordEvent, events: readonly LedgerEvent[]): RecordEvent[] {
  const answered = new Set(
    events.flatMap((event) =>
      event.type === "same_cause" && event.owner === record.owner
        ? [pairKey(event.a, event.b), pairKey(event.b, event.a)]
        : [],
    ),
  );

  const latest = new Map<string, RecordEvent>();

  for (const event of events) {
    if ((event.type === "report" || event.type === "signal") && event.owner === record.owner) {
      latest.set(event.fingerprint, event);
    }
  }

  return deriveGroups(events)
    .filter(
      (group) =>
        group.owner === record.owner &&
        group.status !== "resolved" &&
        group.records > 0 &&
        !group.fingerprints.includes(record.fingerprint) &&
        !answered.has(pairKey(record.fingerprint, group.fingerprint)),
    )
    .flatMap((group) => {
      const example = latest.get(group.fingerprint);

      return example === undefined ? [] : [example];
    })
    .slice(0, MAX_MERGE_COMPARISONS);
}

async function compare(job: ClassifyJob, other: RecordEvent, ask: Asker): Promise<void> {
  const { record } = job;

  const sameCause = probability(
    await ask({ a: sideOf(record), b: sideOf(other) }, SAME_CAUSE_QUESTION),
    "sameCause",
  );

  if (sameCause !== undefined) {
    await appendEvent(
      job.ledger,
      {
        type: "same_cause",
        owner: record.owner,
        a: record.fingerprint,
        b: other.fingerprint,
        model: JEV_MODEL,
        sameCause,
      },
      job.clock,
    );
  }
}

export async function classifyRecord(job: ClassifyJob): Promise<ClassifyOutcome> {
  const { record, registry } = job;

  if (!needsClassifying(record)) {
    return ClassifyOutcome.skipped();
  }

  const catalog = registry.getModelOfType("classifier", JEV_PROVIDER, JEV_CATALOG_ID);

  if (catalog === undefined || !registry.getProviderAuthStatus(JEV_PROVIDER).configured) {
    return ClassifyOutcome.unavailable();
  }

  const model = { ...catalog, id: JEV_MODEL_ID };
  let calls = 0;
  let failed = 0;

  const ask: Asker = async (state, questions) => {
    calls += 1;
    const result = await registry.classify(model, { state, questions });

    if (result.stopReason !== "stop") {
      failed += 1;

      return undefined;
    }

    return result;
  };

  const { events } = await readLedger(job.ledger);
  const scores = await verdictFor(job, events, ask);

  if (scores === undefined || scores.outsideService < THRESHOLDS.excludedOutsideFrom) {
    await Promise.all(
      comparisonsFor(record, events).map(async (other) => compare(job, other, ask)),
    );
  }

  return ClassifyOutcome.classified({ calls, failed });
}
