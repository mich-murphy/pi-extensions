import type { Catalogue, CompiledRecognition, Concept, Recognition } from "./types";

export const JEV_MODEL_ID = "jev-1.13.0";

// Bump this profile whenever extraction, state layout or transport semantics change.
export const CLASSIFIER_REQUEST_PROFILE = {
  version: 2,
  extraction: "annotation-heading-section-replies-v2",
  state: "prompt-and-user_prompt_to_coding_agent-v1",
  transport: "system-one-noul-per-question-criteria-real-work-v1",
} as const;

const REAL_WORK_ONLY =
  "Judge only a request for current, real work. Hypothetical or illustrative examples, questions about what a term means, and research about a practice are not requests for it.";

export function hasClassifierProfiles(catalogue: Catalogue): boolean {
  return catalogue.recognition.some((item) => isProfile(item.questionStyle));
}

function isProfile(style: Recognition["questionStyle"]): boolean {
  return style === "named" || style === "no-criteria" || style === "structured";
}

export function compileClassifierQuestion(
  item: Recognition,
  concept: Concept,
): CompiledRecognition["question"] {
  if (isProfile(item.questionStyle)) {
    const aliases = item.classifierAliases ?? concept.alternativeLabels ?? [];
    const aka = aliases.length > 0 ? ` (also called ${aliases.join(", ")})` : "";
    return {
      type: "bool",
      instructions: `Does \`user_prompt_to_coding_agent\` ask for, or clearly apply, the software practice "${concept.label}"${aka} in the user's current request? "${concept.label}" here means: ${item.matches} ${REAL_WORK_ONLY}`,
      // The native bool API requires strings. onPayload supplies the measured wire shape.
      criteria: {
        true: `The current request asks for or clearly applies ${concept.label}: ${item.matches}`,
        false: `The current request does not ask for ${concept.label}. Cases that are not ${concept.label}: ${item.doesNotMatch}`,
      },
    };
  }
  return {
    type: "bool",
    ...(item.questionStyle === "instructions-focused"
      ? {
          instructions: `${item.matches} Non-matching boundary: ${item.doesNotMatch}`,
          criteria: { true: "The request matches.", false: "The request does not match." },
        }
      : {
          instructions: item.matches,
          criteria: { true: item.matches, false: item.doesNotMatch },
        }),
  };
}

/** The classifier and already-named suppression must always see the same text. */
export function extractClassifierText(catalogue: Catalogue, text: string): string {
  if (!hasClassifierProfiles(catalogue)) {
    return text;
  }
  const replies = annotationSection(text)
    .filter((line) => line.startsWith(">"))
    .map((line) => line.slice(1).trim())
    .filter((line) => line.length > 0);
  return replies.length > 0 ? replies.join("\n") : text;
}

/** Literal headings in prose or fenced examples are not annotation envelopes. */
function annotationSection(text: string): readonly string[] {
  let fence: string | undefined;
  let inAnnotation = false;
  const section: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const marker = /^ {0,3}(?<token>`{3,}|~{3,})(?<suffix>.*)$/u.exec(line);
    const token = marker?.groups?.token;
    if (token !== undefined) {
      fence = nextFence(fence, token, marker?.groups?.suffix ?? "");
      continue;
    }
    if (fence !== undefined) {
      continue;
    }
    if (/^## Annotation(?: [1-9]\d*)?[ \t]*$/u.test(line)) {
      inAnnotation = true;
    } else if (/^#{1,2}[ \t]+/u.test(line)) {
      inAnnotation = false;
    } else if (inAnnotation) {
      section.push(line);
    }
  }
  return section;
}

function nextFence(current: string | undefined, token: string, suffix: string): string | undefined {
  if (current === undefined) {
    return token;
  }
  return token.startsWith(current) && suffix.trim() === "" ? undefined : current;
}

export function classifierState(catalogue: Catalogue, prompt: string): Record<string, string> {
  const text = extractClassifierText(catalogue, prompt);
  return hasClassifierProfiles(catalogue)
    ? { prompt: text, user_prompt_to_coding_agent: text }
    : { prompt: text };
}

function wireQuestion(item: CompiledRecognition, currentWorkOnly: boolean) {
  const { criteria, ...question } = item.question;
  const instructions =
    currentWorkOnly && !isProfile(item.questionStyle)
      ? `${question.instructions} ${REAL_WORK_ONLY}`
      : question.instructions;
  const base = { ...question, instructions, type: "noul" as const };
  if (item.questionStyle === "no-criteria") {
    return base;
  }
  if (item.questionStyle === "structured") {
    return {
      ...base,
      criteria: {
        true: { what: item.matches, not_for: item.doesNotMatch },
        false: {
          what: `The current request is outside ${item.concept.label}.`,
          examples: item.doesNotMatch,
        },
      },
    };
  }
  return { ...base, criteria };
}

/** Used by both policy hashing and the transport hook, never SDK placeholder criteria. */
export function classifierWireQuestions(catalogue: Catalogue) {
  return Object.fromEntries(
    catalogue.recognition.map((item) => [
      item.conceptId,
      wireQuestion(item, hasClassifierProfiles(catalogue)),
    ]),
  );
}

/** Fail closed if the SDK changes the pinned request contract. No nonce is sent. */
export function classifierPayloadHook(catalogue: Catalogue): (payload: unknown) => unknown {
  return (payload) => {
    if (!isRecord(payload) || payload.model !== JEV_MODEL_ID) {
      throw new Error("Unexpected terminology classifier wire model");
    }
    if (
      "nonce" in payload ||
      !isRecord(payload.state) ||
      !isRecord(payload.questions) ||
      Object.keys(payload.questions).length !== catalogue.recognition.length
    ) {
      throw new Error("Invalid terminology classifier payload");
    }
    for (const item of catalogue.recognition) {
      const question = payload.questions[item.conceptId];
      if (
        !isRecord(question) ||
        Object.keys(question).length !== 3 ||
        question.type !== "noul" ||
        question.instructions !== item.question.instructions ||
        !isRecord(question.criteria) ||
        Object.keys(question.criteria).length !== 2 ||
        question.criteria.true !== item.question.criteria.true ||
        question.criteria.false !== item.question.criteria.false
      ) {
        throw new Error("Invalid terminology classifier wire question");
      }
    }
    return { ...payload, questions: classifierWireQuestions(catalogue) };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
