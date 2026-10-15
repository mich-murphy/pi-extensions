import type {
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierResult,
  ClassifierOptions,
  Usage,
} from "@earendil-works/pi-ai";
import type { Catalogue, Match, MatchResult } from "./types";

export const JEV_MODEL_ID = "jev-1.13.0";
export type NativeMatcherResult =
  | { readonly ok: true; readonly value: MatchResult }
  | {
      readonly ok: false;
      readonly reason: "no-model" | "no-auth" | "aborted" | "invalid" | "error";
    };

export type NativeClassifierRegistry = {
  readonly findOfType: (
    type: "classifier",
    provider: "typesafe",
    modelId: "jev-latest",
  ) => ClassifierModel<ClassifierApi> | undefined;
  readonly classify: (
    model: ClassifierModel<ClassifierApi>,
    context: ClassifierContext,
    options: ClassifierOptions,
  ) => Promise<ClassifierResult>;
};

export async function matchWithNativeClassifier(
  registry: NativeClassifierRegistry,
  catalogue: Catalogue,
  prompt: string,
  threshold: number,
  signal: AbortSignal,
): Promise<NativeMatcherResult> {
  const model = registry.findOfType("classifier", "typesafe", "jev-latest");
  if (model === undefined) {
    return { ok: false, reason: "no-model" };
  }
  const questions = Object.fromEntries(
    catalogue.recognition.map((recognition) => [recognition.conceptId, recognition.question]),
  );
  const result = await registry.classify(
    { ...model, id: JEV_MODEL_ID },
    { state: { prompt }, questions },
    { signal, timeoutMs: 5000, maxRetries: 0 },
  );
  return interpretClassifierResult(result, catalogue, threshold);
}

export function interpretClassifierResult(
  result: ClassifierResult,
  catalogue: Catalogue,
  threshold: number,
): NativeMatcherResult {
  if (result.stopReason === "aborted") {
    return { ok: false, reason: "aborted" };
  }
  if (result.stopReason === "error") {
    return { ok: false, reason: "error" };
  }
  const matches: Match[] = [];
  for (const recognition of catalogue.recognition) {
    const answer = result.answers[recognition.conceptId];
    if (answer === undefined || answer.type !== "bool" || !Number.isFinite(answer.probability)) {
      return { ok: false, reason: "invalid" };
    }
    if (answer.probability < 0 || answer.probability > 1) {
      return { ok: false, reason: "invalid" };
    }
    if (answer.probability >= threshold) {
      matches.push({
        concept: recognition.concept,
        recognition,
        probability: answer.probability,
        tip: recognition.tip,
      });
    }
  }
  return { ok: true, value: withUsage(matches, result.usage) };
}

function withUsage(matches: readonly Match[], usage: Usage | undefined): MatchResult {
  return usage === undefined ? { matches } : { matches, usage };
}
