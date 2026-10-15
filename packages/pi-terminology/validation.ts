import { createHash } from "node:crypto";
import { escapeForDisplay, isUnsafeForDisplay } from "./display";
import type {
  BookReference,
  Catalogue,
  CompiledRecognition,
  Concept,
  GlossaryDocument,
  Recognition,
  Reference,
  WebReference,
} from "./types";

export type GlossaryValidationResult =
  | { readonly ok: true; readonly value: GlossaryDocument }
  | { readonly ok: false; readonly errors: readonly string[] };

export type CatalogueValidationResult =
  | { readonly ok: true; readonly value: Catalogue }
  | { readonly ok: false; readonly errors: readonly string[] };

export type GlossaryOrigin = "core" | "project";

const DOCUMENT_KEYS = new Set(["schemaVersion", "namespace", "concepts", "recognition"]);
const CONCEPT_KEYS = new Set([
  "id",
  "label",
  "domain",
  "definition",
  "references",
  "alternativeLabels",
  "scopeNote",
  "relatedConceptIds",
]);
const RECOGNITION_KEYS = new Set([
  "conceptId",
  "matches",
  "doesNotMatch",
  "questionStyle",
  "tip",
  "caution",
]);
const BOOK_KEYS = new Set(["kind", "title", "authors", "edition", "locator", "url", "isbn"]);
const WEB_KEYS = new Set(["kind", "title", "url", "locator", "version"]);
const NAMESPACE_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const LOCAL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

export function normalizeLabel(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replaceAll(/\s+/gu, " ").trim();
}

export function parseGlossary(
  value: unknown,
  source: string,
  origin: GlossaryOrigin = "project",
): GlossaryValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: [`${source}: document must be an object`] };
  }
  rejectUnknown(value, DOCUMENT_KEYS, `${source}: document`, errors);
  if (value.schemaVersion !== 1) {
    errors.push(`${source}: schemaVersion must be 1`);
  }
  const namespace = stringField(value.namespace, `${source}: namespace`, errors);
  validateNamespace(source, namespace, origin, errors);
  const concepts = parseConcepts(value.concepts, source, errors);
  if (origin === "project") {
    validateProjectConceptIds(source, concepts, errors);
  }
  const recognition = parseRecognition(value.recognition, source, errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      namespace,
      concepts,
      recognition,
    },
  };
}

export function composeGlossaries(
  documents: readonly GlossaryDocument[],
): CatalogueValidationResult {
  const state = collectGlossaryRecords(documents);
  validateRecognitionLinks(state);
  if (state.errors.length > 0) {
    return { ok: false, errors: state.errors };
  }
  return { ok: true, value: buildCatalogue(state) };
}

type CompositionState = {
  readonly errors: string[];
  readonly concepts: Map<string, Concept>;
  readonly recognizers: Map<string, Recognition>;
};

function collectGlossaryRecords(documents: readonly GlossaryDocument[]): CompositionState {
  const state: CompositionState = {
    errors: [],
    concepts: new Map(),
    recognizers: new Map(),
  };
  for (const document of documents) {
    for (const concept of document.concepts) {
      addConcept(state, document, concept);
    }
    for (const item of document.recognition) {
      addRecognizer(state, item);
    }
  }
  return state;
}

function addConcept(state: CompositionState, document: GlossaryDocument, concept: Concept): void {
  validateConceptNamespace(state.errors, document, concept);
  if (state.concepts.has(concept.id)) {
    state.errors.push(`${concept.id}: duplicate concept ID`);
  } else {
    state.concepts.set(concept.id, concept);
  }
  if (hasRedundantLabels(concept)) {
    state.errors.push(`${concept.id}: labels are redundant after normalization`);
  }
}

function validateConceptNamespace(
  errors: string[],
  document: GlossaryDocument,
  concept: Concept,
): void {
  const expectedPrefix = `${document.namespace}:`;
  if (!concept.id.startsWith(expectedPrefix)) {
    errors.push(
      `${escapeForDisplay(concept.id)}: concept ID must be in namespace ${escapeForDisplay(document.namespace)}`,
    );
    return;
  }
  const localId = concept.id.slice(expectedPrefix.length);
  if (!LOCAL_ID_PATTERN.test(localId)) {
    errors.push(
      `${escapeForDisplay(concept.id)}: concept ID local part must be lowercase ASCII letters, digits or hyphens`,
    );
  }
}

function validateNamespace(
  source: string,
  namespace: string,
  origin: GlossaryOrigin,
  errors: string[],
): void {
  if (namespace === "") {
    return;
  }
  if (!NAMESPACE_PATTERN.test(namespace)) {
    errors.push(`${source}: namespace must use lowercase ASCII letters, digits or hyphens`);
  }
  if (origin === "core") {
    if (namespace !== "core") {
      errors.push(`${source}: bundled core glossary must declare namespace core`);
    }
  } else if (namespace === "core") {
    errors.push(`${source}: project glossary cannot declare the reserved core namespace`);
  }
}

function validateProjectConceptIds(
  source: string,
  concepts: readonly Concept[],
  errors: string[],
): void {
  for (const concept of concepts) {
    if (concept.id.startsWith("core:")) {
      errors.push(
        `${source}: project glossary cannot define reserved core concept ID ${escapeForDisplay(concept.id)}`,
      );
    }
  }
}

function hasRedundantLabels(concept: Concept): boolean {
  const labels = [concept.label, ...(concept.alternativeLabels ?? [])].map((label) =>
    normalizeLabel(label),
  );
  return new Set(labels).size !== labels.length;
}

function addRecognizer(state: CompositionState, item: Recognition): void {
  if (state.recognizers.has(item.conceptId)) {
    state.errors.push(`${item.conceptId}: duplicate recognizer`);
  } else {
    state.recognizers.set(item.conceptId, item);
  }
}

function validateRecognitionLinks(state: CompositionState): void {
  for (const [conceptId] of state.recognizers) {
    if (!state.concepts.has(conceptId)) {
      state.errors.push(`${conceptId}: recognizer references missing concept`);
    }
  }
  for (const concept of state.concepts.values()) {
    validateRelatedLinks(state, concept);
  }
}

function validateRelatedLinks(state: CompositionState, concept: Concept): void {
  const relatedIds = concept.relatedConceptIds ?? [];
  if (new Set(relatedIds).size !== relatedIds.length) {
    state.errors.push(`${concept.id}: related concept IDs must be distinct`);
  }
  for (const related of relatedIds) {
    if (related === concept.id) {
      state.errors.push(`${concept.id}: related concept must be a distinct meaning`);
    } else if (!state.concepts.has(related)) {
      state.errors.push(`${concept.id}: related concept ${related} is missing`);
    }
  }
}

function buildCatalogue(state: CompositionState): Catalogue {
  const sortedConcepts = [...state.concepts.values()].toSorted((left, right) =>
    left.id.localeCompare(right.id),
  );
  const sortedRecognition = compileRecognition(state).toSorted((left, right) =>
    left.conceptId.localeCompare(right.conceptId),
  );
  return {
    concepts: sortedConcepts,
    recognition: sortedRecognition,
    hash: stableHash({
      concepts: sortedConcepts,
      recognition: sortedRecognition.map((item) => stripCompiled(item)),
    }),
  };
}

function compileRecognition(state: CompositionState): CompiledRecognition[] {
  return [...state.recognizers.values()].flatMap((item) => {
    const concept = state.concepts.get(item.conceptId);
    return concept === undefined ? [] : [compileRecognizer(item, concept)];
  });
}

function compileRecognizer(item: Recognition, concept: Concept): CompiledRecognition {
  return {
    ...item,
    concept,
    question: {
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
    },
  };
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stripCompiled(item: CompiledRecognition): Recognition {
  return {
    conceptId: item.conceptId,
    matches: item.matches,
    doesNotMatch: item.doesNotMatch,
    tip: item.tip,
    ...(item.questionStyle === undefined ? {} : { questionStyle: item.questionStyle }),
    ...(item.caution === undefined ? {} : { caution: item.caution }),
  };
}

function parseConcepts(value: unknown, source: string, errors: string[]): Concept[] {
  if (!Array.isArray(value)) {
    errors.push(`${source}: concepts must be an array`);
    return [];
  }
  const concepts: Concept[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      errors.push(`${source}: concepts[${index}] must be an object`);
      continue;
    }
    rejectUnknown(entry, CONCEPT_KEYS, `${source}: concepts[${index}]`, errors);
    const references = parseReferences(entry.references, `${source}: concepts[${index}]`, errors);
    const alternativeLabels = optionalStringArray(
      entry.alternativeLabels,
      `${source}: concepts[${index}].alternativeLabels`,
      errors,
    );
    const relatedConceptIds = optionalStringArray(
      entry.relatedConceptIds,
      `${source}: concepts[${index}].relatedConceptIds`,
      errors,
    );
    const scopeNote = optionalString(
      entry.scopeNote,
      `${source}: concepts[${index}].scopeNote`,
      errors,
    );
    const concept = {
      id: stringField(entry.id, `${source}: concepts[${index}].id`, errors),
      label: stringField(entry.label, `${source}: concepts[${index}].label`, errors),
      domain: stringField(entry.domain, `${source}: concepts[${index}].domain`, errors),
      definition: stringField(entry.definition, `${source}: concepts[${index}].definition`, errors),
      references,
      ...(alternativeLabels === undefined ? {} : { alternativeLabels }),
      ...(scopeNote === undefined ? {} : { scopeNote }),
      ...(relatedConceptIds === undefined ? {} : { relatedConceptIds }),
    } satisfies Concept;
    concepts.push(concept);
  }
  return concepts;
}

function parseRecognition(value: unknown, source: string, errors: string[]): Recognition[] {
  if (!Array.isArray(value)) {
    errors.push(`${source}: recognition must be an array`);
    return [];
  }
  const items: Recognition[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      errors.push(`${source}: recognition[${index}] must be an object`);
      continue;
    }
    rejectUnknown(entry, RECOGNITION_KEYS, `${source}: recognition[${index}]`, errors);
    const caution = optionalString(
      entry.caution,
      `${source}: recognition[${index}].caution`,
      errors,
    );
    const questionStyle = parseQuestionStyle(
      entry.questionStyle,
      `${source}: recognition[${index}].questionStyle`,
      errors,
    );
    items.push({
      conceptId: stringField(entry.conceptId, `${source}: recognition[${index}].conceptId`, errors),
      matches: stringField(entry.matches, `${source}: recognition[${index}].matches`, errors),
      doesNotMatch: stringField(
        entry.doesNotMatch,
        `${source}: recognition[${index}].doesNotMatch`,
        errors,
      ),
      tip: stringField(entry.tip, `${source}: recognition[${index}].tip`, errors),
      ...(questionStyle === undefined ? {} : { questionStyle }),
      ...(caution === undefined ? {} : { caution }),
    });
  }
  return items;
}

function parseQuestionStyle(
  value: unknown,
  label: string,
  errors: string[],
): Recognition["questionStyle"] {
  if (value === undefined || value === "instructions-focused" || value === "with-criteria") {
    return value;
  }
  errors.push(`${label} must be instructions-focused or with-criteria`);
  return undefined;
}

function parseReferences(value: unknown, label: string, errors: string[]): Reference[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label}.references must be a nonempty array`);
    return [];
  }
  return value.flatMap((entry, index) =>
    parseReference(entry, `${label}.references[${index}]`, errors),
  );
}

function parseReference(entry: unknown, label: string, errors: string[]): Reference[] {
  if (!isRecord(entry)) {
    errors.push(`${label} must be an object`);
    return [];
  }
  if (entry.kind === "book") {
    return [parseBookReference(entry, label, errors)];
  }
  if (entry.kind === "web") {
    return [parseWebReference(entry, label, errors)];
  }
  errors.push(`${label}.kind must be book or web`);
  return [];
}

function parseBookReference(
  entry: Record<string, unknown>,
  label: string,
  errors: string[],
): BookReference {
  rejectUnknown(entry, BOOK_KEYS, label, errors);
  const url = optionalHttpUrl(entry.url, `${label}.url`, errors);
  const isbn = optionalString(entry.isbn, `${label}.isbn`, errors);
  return {
    kind: "book",
    title: stringField(entry.title, `${label}.title`, errors),
    authors: stringArray(entry.authors, `${label}.authors`, errors),
    edition: stringField(entry.edition, `${label}.edition`, errors),
    locator: stringField(entry.locator, `${label}.locator`, errors),
    ...(url === undefined ? {} : { url }),
    ...(isbn === undefined ? {} : { isbn }),
  };
}

function parseWebReference(
  entry: Record<string, unknown>,
  label: string,
  errors: string[],
): WebReference {
  rejectUnknown(entry, WEB_KEYS, label, errors);
  const locator = optionalString(entry.locator, `${label}.locator`, errors);
  const version = optionalString(entry.version, `${label}.version`, errors);
  return {
    kind: "web",
    title: stringField(entry.title, `${label}.title`, errors),
    url: httpUrl(entry.url, `${label}.url`, errors),
    ...(locator === undefined ? {} : { locator }),
    ...(version === undefined ? {} : { version }),
  };
}

function stringField(value: unknown, label: string, errors: string[]): string {
  if (nonEmpty(value)) {
    if (isUnsafeForDisplay(value)) {
      errors.push(`${label} contains unsafe control or bidi text`);
    }
    return value;
  }
  errors.push(`${label} must be a nonempty string`);
  return "";
}

function optionalString(value: unknown, label: string, errors: string[]): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return stringField(value, label, errors);
}

function stringArray(value: unknown, label: string, errors: string[]): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must be a nonempty string array`);
    return [];
  }
  const strings: string[] = [];
  for (const [index, item] of value.entries()) {
    strings.push(stringField(item, `${label}[${index}]`, errors));
  }
  return strings;
}

function optionalStringArray(
  value: unknown,
  label: string,
  errors: string[],
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return stringArray(value, label, errors);
}

function httpUrl(value: unknown, label: string, errors: string[]): string {
  const text = stringField(value, label, errors);
  if (text === "") {
    return text;
  }
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      errors.push(`${label} must use http or https`);
    }
    if (parsed.username !== "" || parsed.password !== "") {
      errors.push(`${label} must not include username or password`);
    }
  } catch {
    errors.push(`${label} must be a valid URL`);
  }
  return text;
}

function optionalHttpUrl(value: unknown, label: string, errors: string[]): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return httpUrl(value, label, errors);
}

function rejectUnknown(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
  errors: string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      errors.push(`${label}: unknown field ${escapeForDisplay(key)}`);
    }
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
