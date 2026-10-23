import type {
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierResult,
  ClassifierOptions,
  Usage,
} from "@earendil-works/pi-ai";
import { JEV_MODEL_ID, classifierPayloadHook, classifierState } from "./classifier-request";
import type { Catalogue, Match, MatchResult } from "./types";

export { JEV_MODEL_ID } from "./classifier-request";
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
  conceptThresholds?: Readonly<Record<string, number>>,
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
    { state: classifierState(catalogue, prompt), questions },
    { signal, timeoutMs: 5000, maxRetries: 0, onPayload: classifierPayloadHook(catalogue) },
  );
  return interpretClassifierResult(result, catalogue, threshold, conceptThresholds);
}

export function interpretClassifierResult(
  result: ClassifierResult,
  catalogue: Catalogue,
  threshold: number,
  conceptThresholds?: Readonly<Record<string, number>>,
): NativeMatcherResult {
  if (result.stopReason === "aborted") {
    return { ok: false, reason: "aborted" };
  }
  if (result.stopReason === "error") {
    return { ok: false, reason: "error" };
  }
  if (
    conceptThresholds !== undefined &&
    Object.keys(conceptThresholds).length !== catalogue.recognition.length
  ) {
    return { ok: false, reason: "invalid" };
  }
  const matches: Match[] = [];
  for (const recognition of catalogue.recognition) {
    const probability = answerProbability(result.answers[recognition.conceptId]);
    if (probability === undefined) {
      return { ok: false, reason: "invalid" };
    }
    const cutoff =
      conceptThresholds === undefined ? threshold : conceptThresholds[recognition.conceptId];
    if (!isProbability(cutoff) || (conceptThresholds !== undefined && cutoff === 0)) {
      return { ok: false, reason: "invalid" };
    }
    if (probability >= cutoff) {
      matches.push({
        concept: recognition.concept,
        recognition,
        probability,
        tip: recognition.tip,
      });
    }
  }
  return { ok: true, value: withUsage(matches, result.usage) };
}

function answerProbability(
  answer: ClassifierResult["answers"][string] | undefined,
): number | undefined {
  return answer?.type === "bool" && isProbability(answer.probability)
    ? answer.probability
    : undefined;
}

function isProbability(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1;
}

function withUsage(matches: readonly Match[], usage: Usage | undefined): MatchResult {
  return usage === undefined ? { matches } : { matches, usage };
}
