import type {
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierResult,
} from "@earendil-works/pi-ai";
import type { ClassifierRegistry } from "../classify.ts";

export type FakeAnswer = (context: ClassifierContext) => Readonly<Record<string, number>> | "error";

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
  const calls: { model: string; context: ClassifierContext }[] = [];

  const registry: ClassifierRegistry = {
    getProviderAuthStatus: () => ({ configured }),
    getModelOfType: (_type, provider, modelId) =>
      provider === jevLatest.provider && modelId === jevLatest.id ? jevLatest : undefined,
    classify: async (model, context) => {
      calls.push({ model: model.id, context });
      const given = answer(context);

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
                Object.entries(given).map(([id, probability]) => [
                  id,
                  { type: "bool" as const, probability },
                ]),
              ),
              stopReason: "stop",
            };

      return result;
    },
  };

  return { registry, calls };
}

export const noClassifier: ClassifierRegistry = fakeClassifier(() => "error", false).registry;
