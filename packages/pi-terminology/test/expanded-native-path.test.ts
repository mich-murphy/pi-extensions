import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { AuthStorage } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { loadCatalogue } from "../catalogue";
import { classifierState, classifierWireQuestions, JEV_MODEL_ID } from "../classifier-request";
import { matchWithNativeClassifier } from "../native-matcher";

async function registry() {
  const runtime = await ModelRuntime.create({
    credentials: AuthStorage.inMemory({}),
    modelsPath: null,
    refreshOnCreate: false,
  });
  await runtime.login("typesafe", "api_key", {
    prompt: async () => "synthetic-offline-only",
    notify: () => undefined,
  });
  return new ModelRegistry(runtime);
}

function requestBody(body: RequestInit["body"]): unknown {
  if (typeof body !== "string") {
    throw new TypeError("Expected JSON request body");
  }
  return JSON.parse(body);
}

describe("complete glossary through the pinned native registry and SDK", () => {
  test.each([
    {
      name: "complete",
      omitted: [],
      expected: {
        ok: true,
        value: {
          matches: [{ concept: { id: "core:deep-module" }, probability: 0.97 }],
          usage: { input: 100, output: 51 },
        },
      },
    },
    { name: "missing final answer", omitted: ["core:blinded-evaluation"], expected: { ok: false } },
  ])("validates all 51 transported probabilities: $name", async ({ omitted, expected }) => {
    const native = await registry();
    const { catalogue } = loadCatalogue();
    const prompt =
      '# Annotations\n## Annotation 1\nComment on: "deep module"\n> Hide the coordination behind a small interface that delivers substantial functionality.';
    const requests: unknown[] = [];
    const omittedIds = new Set<string>(omitted);
    const probabilities = new Map(catalogue.recognition.map((item) => [item.conceptId, 0.01]));
    probabilities.set("core:deep-module", 0.97);
    const transport: typeof globalThis.fetch = async (_url, init) => {
      requests.push(requestBody(init?.body));
      return Response.json({
        answers: Object.fromEntries(
          catalogue.recognition
            .filter((item) => !omittedIds.has(item.conceptId))
            .map((item) => [
              item.conceptId,
              {
                type: "noul",
                noul: probabilities.get(item.conceptId),
              },
            ]),
        ),
        usage: { input_tokens: 100, output_tokens: 51 },
      });
    };
    const result = await matchWithNativeClassifier(
      {
        findOfType: (...args) => native.findOfType(...args),
        classify: async (model, context, options) =>
          native.classify(model, context, { ...options, fetch: transport }),
      },
      catalogue,
      prompt,
      0.95,
      new AbortController().signal,
    );
    expect(catalogue.recognition).toHaveLength(51);
    expect(requests).toStrictEqual([
      {
        model: JEV_MODEL_ID,
        state: classifierState(catalogue, prompt),
        questions: classifierWireQuestions(catalogue),
      },
    ]);
    expect(result).toMatchObject(expected);
  });
});
