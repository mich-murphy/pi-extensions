import type { ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import {
  JEV_MODEL_ID,
  interpretClassifierResult,
  matchWithNativeClassifier,
} from "../native-matcher";
import type { Catalogue } from "../types";

const concept = {
  id: "core:mutation-testing",
  label: "mutation testing",
  domain: "testing",
  definition: "definition",
  references: [{ kind: "web", title: "Source", url: "https://example.com" }],
} as const;
const recognition = {
  conceptId: concept.id,
  matches: "mutate production",
  doesNotMatch: "fuzz",
  tip: "A term for this activity is mutation testing.",
  concept,
  question: {
    type: "bool",
    instructions: "Does it match?",
    criteria: { true: "yes", false: "no" },
  },
} as const;
const catalogue: Catalogue = { concepts: [concept], recognition: [recognition], hash: "hash" };
const match = { concept, recognition, probability: 0.97, tip: recognition.tip };

describe("native matcher", () => {
  test("sends unchanged prompt, pinned model and bounded native options", async () => {
    const prompt = "Please change production code to see whether tests catch it.";
    let observed:
      | {
          readonly modelId: string;
          readonly statePrompt: unknown;
          readonly timeoutMs: number | undefined;
          readonly maxRetries: number | undefined;
        }
      | undefined;
    type MatcherRegistry = Parameters<typeof matchWithNativeClassifier>[0];
    const model: ClassifierModel<ClassifierApi> = {
      type: "classifier",
      id: "jev-latest",
      name: "Jev",
      api: "typesafe-system-one",
      provider: "typesafe",
      baseUrl: "https://api.typesafe.ai/v1/",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 64_000,
    };
    const classify: MatcherRegistry["classify"] = async (classifiedModel, context, options) => {
      observed = {
        modelId: classifiedModel.id,
        statePrompt: context.state.prompt,
        timeoutMs: options?.timeoutMs,
        maxRetries: options?.maxRetries,
      };
      return {
        api: "typesafe-system-one",
        provider: "typesafe",
        model: classifiedModel.id,
        answers: { [concept.id]: { type: "bool", probability: 0.97 } },
        stopReason: "stop",
        timestamp: 1,
      };
    };
    const registry = {
      findOfType: () => model,
      classify,
    };
    const result = await matchWithNativeClassifier(
      registry,
      catalogue,
      prompt,
      0.95,
      new AbortController().signal,
    );
    expect(observed).toStrictEqual({
      modelId: JEV_MODEL_ID,
      statePrompt: prompt,
      timeoutMs: 5000,
      maxRetries: 0,
    });
    expect(result).toMatchObject({ ok: true, value: { matches: [match] } });
  });

  test("selects bool answers at threshold", () => {
    const result = interpretClassifierResult(
      {
        api: "typesafe-system-one",
        provider: "typesafe",
        model: "jev-1.13.0",
        answers: { [concept.id]: { type: "bool", probability: 0.97 } },
        stopReason: "stop",
        timestamp: 1,
      },
      catalogue,
      0.95,
    );
    expect(result).toMatchObject({ ok: true, value: { matches: [match] } });
  });

  test("rejects malformed probabilities", () => {
    const result = interpretClassifierResult(
      {
        api: "typesafe-system-one",
        provider: "typesafe",
        model: "jev-1.13.0",
        answers: { [concept.id]: { type: "bool", probability: 2 } },
        stopReason: "stop",
        timestamp: 1,
      },
      catalogue,
      0.95,
    );
    expect(result).toStrictEqual({ ok: false, reason: "invalid" });
  });
});
