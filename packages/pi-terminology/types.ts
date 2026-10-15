import type { Usage } from "@earendil-works/pi-ai";

export type Namespace = "core" | (string & {});

export type GlossaryDocument = {
  readonly schemaVersion: 1;
  readonly namespace: Namespace;
  readonly concepts: readonly Concept[];
  readonly recognition: readonly Recognition[];
};

export type Concept = {
  readonly id: string;
  readonly label: string;
  readonly domain: string;
  readonly definition: string;
  readonly references: readonly Reference[];
  readonly alternativeLabels?: readonly string[];
  readonly scopeNote?: string;
  readonly relatedConceptIds?: readonly string[];
};

export type BookReference = {
  readonly kind: "book";
  readonly title: string;
  readonly authors: readonly string[];
  readonly edition: string;
  readonly locator: string;
  readonly url?: string;
  readonly isbn?: string;
};

export type WebReference = {
  readonly kind: "web";
  readonly title: string;
  readonly url: string;
  readonly locator?: string;
  readonly version?: string;
};

export type Reference = BookReference | WebReference;

export type Recognition = {
  readonly conceptId: string;
  readonly matches: string;
  readonly doesNotMatch: string;
  /** Prompt-recognition names; may include a related principle rather than a glossary synonym. */
  readonly classifierAliases?: readonly string[];
  readonly questionStyle?:
    | "instructions-focused"
    | "with-criteria"
    | "named"
    | "no-criteria"
    | "structured";
  readonly tip: string;
  readonly caution?: string;
};

export type Catalogue = {
  readonly concepts: readonly Concept[];
  readonly recognition: readonly CompiledRecognition[];
  readonly hash: string;
};

export type CompiledRecognition = Recognition & {
  readonly concept: Concept;
  readonly question: {
    readonly type: "bool";
    readonly instructions: string;
    readonly criteria: { readonly true: string; readonly false: string };
  };
};

export type Policy = {
  readonly schemaVersion: 1;
  readonly model: "jev-1.13.0";
  readonly catalogueHash: string;
  readonly criteriaHash: string;
  readonly fixtureHash: string;
  readonly threshold: number;
  readonly conceptThresholds?: Readonly<Record<string, number>>;
  readonly precisionTarget?: number;
  readonly measuredDisplayedPrecision: number;
  readonly measured: boolean;
};

export type Match = {
  readonly concept: Concept;
  readonly recognition: CompiledRecognition;
  readonly probability: number;
  readonly tip: string;
};

export type MatchResult = {
  readonly matches: readonly Match[];
  readonly usage?: Usage;
};
