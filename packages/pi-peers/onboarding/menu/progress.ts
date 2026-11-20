import { visibleText } from "../../adapter/config.js";
import type { MenuModel } from "./model.js";

const MAX_FACTS = 12;
const MAX_TEXT = 160;
const MAX_TECHNICAL = 24;
/** Visible, single-line text: controls escaped, whitespace runs squashed. */
function clean(value: string, limit = 2000): string {
  const text = visibleText(value.replaceAll(/\s+/gu, " ").trim());
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** What an action did: the first line, fact rows and the next step. Stored as `peers-report`. */
export type Outcome = {
  readonly ok: boolean;
  readonly headline: string;
  readonly facts: readonly (readonly [string, string])[];
  readonly next?: string;
  /** Internal detail, shown only under "Technical details". */
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

/** One notification: the headline and the next step. Pi adds its own `Error:` or `Warning:`. */
export function outcomeText(outcome: Outcome): string {
  const headline = clean(outcome.headline).replace(/^[✗!] /u, "");
  return outcome.next === undefined ? headline : `${headline}. ${clean(outcome.next)}`;
}

/** Notification level: a failure is an error, saved-but-not-active a warning. */
export function outcomeLevel(outcome: Outcome): "info" | "warning" | "error" {
  if (outcome.ok) {
    return "info";
  }
  return outcome.headline.startsWith("!") ? "warning" : "error";
}

function pair(value: unknown): readonly [string, string] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items: unknown[] = value;
  const [label, text] = items;
  return typeof label === "string" && typeof text === "string"
    ? [clean(label, MAX_TEXT), clean(text, MAX_TEXT)]
    : undefined;
}

/** A stored report entry, or undefined when the session data has another shape. */
export function storedOutcome(data: unknown): Outcome | undefined {
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const ok: unknown = Reflect.get(data, "ok");
  const headline: unknown = Reflect.get(data, "headline");
  const facts: unknown = Reflect.get(data, "facts");
  const next: unknown = Reflect.get(data, "next");
  const technical: unknown = Reflect.get(data, "technical");
  if (typeof ok !== "boolean" || typeof headline !== "string" || !Array.isArray(facts)) {
    return undefined;
  }
  const rows: unknown[] = facts;
  return {
    ok,
    headline: clean(headline, MAX_TEXT),
    facts: rows.slice(0, MAX_FACTS).flatMap((row) => {
      const value = pair(row);
      return value === undefined ? [] : [value];
    }),
    ...(typeof next === "string" ? { next: clean(next, MAX_TEXT * 2) } : {}),
    ...(Array.isArray(technical)
      ? {
          technical: technical
            .slice(0, MAX_TECHNICAL)
            .filter((line): line is string => typeof line === "string")
            .map((line) => clean(line, MAX_TEXT * 4)),
        }
      : {}),
  };
}

type Running = { readonly text: string; readonly started: number; ended?: number };

async function settle(work: (step: Step) => Promise<Outcome>, step: Step): Promise<Outcome> {
  try {
    return await work(step);
  } catch {
    return { ok: false, headline: "✗ Failed: unexpected error", facts: [] };
  }
}

/**
 * Pushes a progress screen titled `title`, runs `work`, then replaces the screen with the outcome.
 * Step rows read `✓ ` done, `… ` running (with elapsed seconds) and `· ` planned. Esc hides the view
 * (the model closes) while the work continues; `finished` learns whether it was hidden.
 */
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
    ...planned
      .filter((text) => !steps.some((item) => item.text === text))
      .map((text) => `· ${clean(text)}`),
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
  })().catch(() => {
    // A failing report (for example a UI gone at shutdown) never becomes an unhandled rejection.
  });
  model.push({ kind: "progress", title, lines, done });
  return done;
}
