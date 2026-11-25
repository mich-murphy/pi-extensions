import { flow, Option, Schema } from "effect";
import { visibleText } from "../../adapter/config.js";
import type { MenuModel } from "./model.js";

const MAX_FACTS = 12;
const MAX_TEXT = 160;
const MAX_TECHNICAL = 24;

function clean(value: string, limit = 2000): string {
  const text = visibleText(value.replaceAll(/\s+/gu, " ").trim());

  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export type Outcome = {
  readonly ok: boolean;
  readonly headline: string;
  readonly facts: readonly (readonly [string, string])[];
  readonly next?: string;
  readonly technical?: readonly string[];
};

export type Step = (message: string) => void;

export function outcomeLines(outcome: Outcome): string[] {
  return [
    clean(outcome.headline),
    ...(outcome.next === undefined ? [] : [`Next: ${clean(outcome.next)}`]),
    ...outcome.facts.map(([label, value]) => `${clean(label)}: ${clean(value)}`),
    ...(outcome.technical === undefined || outcome.technical.length === 0
      ? []
      : ["Technical details:", ...outcome.technical.map((line) => `  ${clean(line)}`)]),
  ];
}

export function outcomeText(outcome: Outcome): string {
  const headline = clean(outcome.headline).replace(/^[✗!] /u, "");

  return outcome.next === undefined ? headline : `${headline}. ${clean(outcome.next)}`;
}

export function outcomeLevel(outcome: Outcome): "info" | "warning" | "error" {
  if (outcome.ok) {
    return "info";
  }

  return outcome.headline.startsWith("!") ? "warning" : "error";
}

const isFact = Schema.is(
  Schema.TupleWithRest(Schema.Tuple([Schema.String, Schema.String]), [Schema.Unknown]),
);

const isString = Schema.is(Schema.String);
const decodeRows = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));

const StoredReport = Schema.Struct({
  ok: Schema.Boolean,
  headline: Schema.String,
  facts: Schema.Array(Schema.Unknown),
  next: Schema.optional(Schema.Unknown),
  technical: Schema.optional(Schema.Unknown),
});

function restoreOutcome({
  ok,
  headline,
  facts,
  next,
  technical,
}: typeof StoredReport.Type): Outcome {
  const lines = Option.getOrUndefined(decodeRows(technical));

  const rows: Outcome["facts"] = facts
    .slice(0, MAX_FACTS)
    .flatMap((row) =>
      isFact(row) ? [[clean(row[0], MAX_TEXT), clean(row[1], MAX_TEXT)] as const] : [],
    );

  const outcome: Omit<Outcome, "next" | "technical"> & {
    next?: string;
    technical?: readonly string[];
  } = { ok, headline: clean(headline, MAX_TEXT), facts: rows };

  if (isString(next)) {
    outcome.next = clean(next, MAX_TEXT * 2);
  }

  if (lines !== undefined) {
    outcome.technical = lines
      .slice(0, MAX_TECHNICAL)
      .flatMap((line) => (isString(line) ? [clean(line, MAX_TEXT * 4)] : []));
  }

  return outcome;
}

export const storedOutcome = flow(
  Schema.decodeUnknownOption(StoredReport),
  Option.map(restoreOutcome),
  Option.getOrUndefined,
);

type Running = { readonly text: string; readonly started: number; ended?: number };

async function settle(work: (step: Step) => Promise<Outcome>, step: Step): Promise<Outcome> {
  try {
    return await work(step);
  } catch {
    return { ok: false, headline: "✗ Failed: unexpected error", facts: [] };
  }
}

function ignoreReportFailureAfterUiIsGone(): undefined {
  return undefined;
}

export async function runWithProgress(
  model: MenuModel,
  title: string,
  planned: readonly string[],
  work: (step: Step) => Promise<Outcome>,
  finished: (outcome: Outcome, hidden: boolean) => void,
  result = "Result",
): Promise<void> {
  const steps: Running[] = [];

  const step: Step = (text) => {
    const last = steps.at(-1);

    if (last?.text === text && last.ended === undefined) {
      return;
    }

    const now = Date.now();

    if (last !== undefined && last.ended === undefined) {
      last.ended = now;
    }

    steps.push({ text, started: now });
    model.refresh();
  };

  const lines = (): string[] => [
    ...steps.map((item) =>
      item.ended === undefined
        ? `… ${clean(item.text)} (${Math.round((Date.now() - item.started) / 1000)}s)`
        : `✓ ${clean(item.text)}`,
    ),
    ...planned.flatMap((text) =>
      steps.some((item) => item.text === text) ? [] : [`· ${clean(text)}`],
    ),
  ];

  const timer = setInterval(() => {
    model.refresh();
  }, 1000);

  timer.unref();

  const done = (async () => {
    const outcome = await settle(work, step);
    clearInterval(timer);
    const hidden = model.closed;
    model.replace({ kind: "outcome", title: result, lines: () => outcomeLines(outcome) });

    try {
      finished(outcome, hidden);
    } finally {
      model.refresh();
    }
  })().catch(ignoreReportFailureAfterUiIsGone);

  model.push({ kind: "progress", title, lines, done });

  return done;
}
