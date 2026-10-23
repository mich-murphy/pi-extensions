import type { Catalogue, Match } from "./types";
import { normalizeLabel } from "./validation";

const MAX_PROMPT_CHARS = 60_000;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const HISTORY_WORDS =
  /\b(?:historically|previously|formerly|once|used to|we used|they used|called|known as|mentioned)\b/iu;
const QUOTED_TEXT = /(?<![\p{L}\p{N}])'[^']*'(?![\p{L}\p{N}])|"[^"]*"|`[^`]*`|“[^”]*”|‘[^’]*’/gu;
const NEGATED_SPAN =
  /\b(?:do not|don't|not|avoid|without|no|never)\s+[\p{L}\p{N}\s/`'"“”‘’\p{Dash_Punctuation}]{0,80}/giu;
const POSITIVE_VERB = String.raw`(?:use|apply|adopt)`;
const LABEL_BOUNDARY = String.raw`[\p{L}\p{N}]`;
const LABEL_SEPARATOR = String.raw`[\s/\p{Dash_Punctuation}]+`;

export type SelectionState = {
  readonly hiddenConceptIds: ReadonlySet<string>;
  readonly dismissedConceptIds: ReadonlySet<string>;
  readonly cooldowns: ReadonlyMap<string, number>;
};

export function promptTooLarge(prompt: string): boolean {
  return prompt.length > MAX_PROMPT_CHARS;
}

export function suppressAlreadyNamed(prompt: string, catalogue: Catalogue): ReadonlySet<string> {
  const negationRemoved = prompt.replaceAll(NEGATED_SPAN, " ");
  // Naming a term in a current request already makes a vocabulary reminder
  // redundant, including requests to avoid it (e.g. accidental complexity).
  // Quoted and historical context still does not establish current familiarity.
  const unquotedCurrent = prompt.replaceAll(QUOTED_TEXT, " ");
  const normalizedPrompt = normalizeForSearch(unquotedCurrent);
  const suppressed = new Set<string>();
  for (const concept of catalogue.concepts) {
    const classifierAliases =
      catalogue.recognition.find((item) => item.conceptId === concept.id)?.classifierAliases ?? [];
    const labels = [concept.label, ...(concept.alternativeLabels ?? []), ...classifierAliases];
    if (
      labels.some(
        (label) =>
          affirmativelyContainsLabel(normalizedPrompt, unquotedCurrent, label) ||
          affirmativelyQuotesLabel(negationRemoved, label),
      )
    ) {
      suppressed.add(concept.id);
    }
  }
  return suppressed;
}

function affirmativelyContainsLabel(
  normalizedPrompt: string,
  prompt: string,
  label: string,
): boolean {
  if (!containsNormalizedLabel(normalizedPrompt, label)) {
    return false;
  }
  const labelPattern = labelRegex(label);
  const raw = new RegExp(
    `(.{0,40})(?<!${LABEL_BOUNDARY})${labelPattern}(?!${LABEL_BOUNDARY})(.{0,20})`,
    "giu",
  );
  for (const match of prompt.matchAll(raw)) {
    const context = `${match[1] ?? ""} ${match[2] ?? ""}`;
    if (!HISTORY_WORDS.test(context)) {
      return true;
    }
  }
  return false;
}

function containsNormalizedLabel(normalizedPrompt: string, label: string): boolean {
  const normalizedLabel = normalizeForSearch(label);
  return normalizedPrompt.includes(normalizedLabel);
}

function affirmativelyQuotesLabel(prompt: string, label: string): boolean {
  const labelPattern = labelRegex(label);
  const raw = new RegExp(
    `(?<!${LABEL_BOUNDARY})${POSITIVE_VERB}(?!${LABEL_BOUNDARY})[\\s:]+(?:\`${labelPattern}\`|"${labelPattern}"|'${labelPattern}'|“${labelPattern}”|‘${labelPattern}’)`,
    "giu",
  );
  for (const match of prompt.matchAll(raw)) {
    if (!HISTORY_WORDS.test(match[0])) {
      return true;
    }
  }
  return false;
}

function labelRegex(label: string): string {
  return normalizeLabel(label)
    .split(/[\s/\p{Dash_Punctuation}]+/u)
    .filter((part) => part.length > 0)
    .map((part) => escapeRegex(part))
    .join(LABEL_SEPARATOR);
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function normalizeForSearch(value: string): string {
  return ` ${normalizeLabel(value.replaceAll(/[^\p{L}\p{N}]+/gu, " "))} `;
}

export function selectMatches(
  matches: readonly Match[],
  state: SelectionState,
  now: number,
  alreadyNamed: ReadonlySet<string>,
): readonly Match[] {
  const visible = matches.filter((match) => isSelectable(match, state, now, alreadyNamed));
  const ambiguous = ambiguousConceptIds(visible);
  return visible.filter((match) => !ambiguous.has(match.concept.id));
}

function isSelectable(
  match: Match,
  state: SelectionState,
  now: number,
  alreadyNamed: ReadonlySet<string>,
): boolean {
  if (state.hiddenConceptIds.has(match.concept.id) || alreadyNamed.has(match.concept.id)) {
    return false;
  }
  const until = state.cooldowns.get(match.concept.id);
  if (until !== undefined && until > now) {
    return false;
  }
  return !state.dismissedConceptIds.has(match.concept.id);
}

function ambiguousConceptIds(matches: readonly Match[]): ReadonlySet<string> {
  const owners = new Map<string, Set<string>>();
  for (const match of matches) {
    for (const label of [match.concept.label, ...(match.concept.alternativeLabels ?? [])]) {
      const normalized = normalizeLabel(label);
      const ids = owners.get(normalized) ?? new Set<string>();
      ids.add(match.concept.id);
      owners.set(normalized, ids);
    }
  }
  const ambiguous = new Set<string>();
  for (const ids of owners.values()) {
    if (ids.size > 1) {
      for (const id of ids) {
        ambiguous.add(id);
      }
    }
  }
  return ambiguous;
}

export function nextCooldown(now: number): number {
  return now + COOLDOWN_MS;
}
