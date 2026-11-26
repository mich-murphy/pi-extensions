import type {
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierResult,
} from "@earendil-works/pi-ai";
import { Predicate } from "effect";
import type { ClassifierRegistry } from "../classify.ts";

export type FakeChoice = {
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
};

export type FakeAnswer = (
  context: ClassifierContext,
) => Readonly<Record<string, number | FakeChoice>> | "error" | "hang";

function answerOf(given: number | FakeChoice): ClassifierResult["answers"][string] {
  return Predicate.isNumber(given)
    ? { type: "bool", probability: given }
    : {
        type: "choice",
        choice: given.choice,
        probabilities: { ...given.probabilities },
        confidence: given.probabilities[given.choice] ?? 0,
      };
}

const jevLatest: ClassifierModel<ClassifierApi> = {
  type: "classifier",
  id: "jev-latest",
  name: "Jev",
  api: "typesafe-system-one",
  provider: "typesafe",
  baseUrl: "https://api.typesafe.invalid/v1/",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64_000,
};

export function fakeClassifier(answer: FakeAnswer, configured = true) {
  const calls: Array<{ model: string; context: ClassifierContext; signal: AbortSignal }> = [];

  const registry: ClassifierRegistry = {
    getProviderAuthStatus: () => ({ configured }),
    getModelOfType: (_type, provider, modelId) =>
      provider === jevLatest.provider && modelId === jevLatest.id ? jevLatest : undefined,
    classify: async (model, context, { signal }) => {
      calls.push({ model: model.id, context, signal });
      const given = answer(context);

      if (given === "hang") {
        return Promise.withResolvers<ClassifierResult>().promise;
      }

      const base = {
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: 0,
      };

      const result: ClassifierResult =
        given === "error"
          ? { ...base, answers: {}, stopReason: "error", errorMessage: "fake failure" }
          : {
              ...base,
              answers: Object.fromEntries(
                Object.entries(given).map(([id, value]) => [id, answerOf(value)]),
              ),
              stopReason: "stop",
            };

      return result;
    },
  };

  return { registry, calls };
}

export const noClassifier: ClassifierRegistry = fakeClassifier(() => "error", false).registry;
