import type { ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import {
  JEV_MODEL_ID,
  interpretClassifierResult,
  matchWithNativeClassifier,
} from "../native-matcher";
import type { Catalogue } from "../types";
import { expectOk } from "./helpers";

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

describe("per-concept cutoffs", () => {
  const secondConcept = { ...concept, id: "core:other", label: "other" };
  const secondRecognition = {
    ...recognition,
    conceptId: secondConcept.id,
    concept: secondConcept,
  };
  const combined: Catalogue = {
    ...catalogue,
    concepts: [concept, secondConcept],
    recognition: [recognition, secondRecognition],
  };
  function result(first: number, second: number) {
    return {
      api: "typesafe-system-one" as const,
      provider: "typesafe",
      model: JEV_MODEL_ID,
      answers: {
        [concept.id]: { type: "bool" as const, probability: first },
        [secondConcept.id]: { type: "bool" as const, probability: second },
      },
      stopReason: "stop" as const,
      timestamp: 1,
    };
  }
  const cutoffs = { [concept.id]: 0.85, [secondConcept.id]: 0.91 };

  test("uses exact individual boundaries rather than the global threshold", () => {
    expect(interpretClassifierResult(result(0.85, 0.909), combined, 0.5, cutoffs)).toMatchObject({
      ok: true,
      value: { matches: [{ concept }] },
    });
    expect(interpretClassifierResult(result(0.849, 0.91), combined, 0.99, cutoffs)).toMatchObject({
      ok: true,
      value: { matches: [{ concept: secondConcept }] },
    });
    expect(interpretClassifierResult(result(0.849, 0.909), combined, 0.5, cutoffs)).toMatchObject({
      ok: true,
      value: { matches: [] },
    });
  });

  test("validates all known answers even when an earlier answer already matched", () => {
    for (const probability of [Number.NaN, Infinity, -0.01, 1.01]) {
      expect(
        interpretClassifierResult(result(0.99, probability), combined, 0.85, cutoffs),
      ).toStrictEqual({ ok: false, reason: "invalid" });
    }
    const missing = {
      ...result(0.99, 0.99),
      answers: { [concept.id]: { type: "bool" as const, probability: 0.99 } },
    };
    expect(interpretClassifierResult(missing, combined, 0.85, cutoffs)).toStrictEqual({
      ok: false,
      reason: "invalid",
    });
  });

  test("fails closed instead of falling back for incomplete or invalid maps", () => {
    for (const thresholds of [
      {},
      { [concept.id]: 0.85 },
      { ...cutoffs, extra: 0.9 },
      ...[0, Number.NaN, Infinity, -0.1, 1.01].map((value) => ({
        ...cutoffs,
        [secondConcept.id]: value,
      })),
    ]) {
      expect(
        interpretClassifierResult(result(0.99, 0.99), combined, 0.85, thresholds),
      ).toStrictEqual({ ok: false, reason: "invalid" });
    }
  });

  test("native API supplies both extracted state keys, payload hook, map, and bounded options", async () => {
    const { composeGlossaries } = await import("../validation");
    const composed = expectOk(
      composeGlossaries([
        {
          schemaVersion: 1,
          namespace: "core",
          concepts: [concept, secondConcept],
          recognition: [recognition, { ...secondRecognition, questionStyle: "structured" }],
        },
      ]),
    );
    type Registry = Parameters<typeof matchWithNativeClassifier>[0];
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
    const signal = new AbortController().signal;
    const classify: Registry["classify"] = async (pinned, context, options) => {
      expect(pinned.id).toBe(JEV_MODEL_ID);
      expect(context.state).toStrictEqual({
        prompt: "Current work",
        user_prompt_to_coding_agent: "Current work",
      });
      expect(context.questions[concept.id]).toStrictEqual(composed.recognition[0]?.question);
      expect(options).toMatchObject({ signal, timeoutMs: 5000, maxRetries: 0 });
      const questions = Object.fromEntries(
        Object.entries(context.questions).map(([id, q]) => [id, { ...q, type: "noul" }]),
      );
      const payload = { model: pinned.id, state: context.state, questions };
      await expect(Promise.resolve(options.onPayload?.(payload, pinned))).resolves.toMatchObject({
        questions: {
          [secondConcept.id]: {
            type: "noul",
            criteria: {
              true: { what: secondRecognition.matches, not_for: secondRecognition.doesNotMatch },
            },
          },
        },
      });
      expect(() => options.onPayload?.({ ...payload, model: "jev-latest" }, pinned)).toThrow(
        "Unexpected terminology classifier wire model",
      );
      return result(0.85, 0.9);
    };
    await expect(
      matchWithNativeClassifier(
        { findOfType: () => model, classify },
        composed,
        "Pasted mutation testing\n## Annotation\n> Current work",
        0.5,
        signal,
        cutoffs,
      ),
    ).resolves.toMatchObject({ ok: true, value: { matches: [{ concept }] } });
  });
});
