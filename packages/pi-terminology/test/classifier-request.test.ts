import type { ClassifierModel } from "@earendil-works/pi-ai";
import { classify } from "@earendil-works/pi-ai/api/typesafe-system-one";
import { describe, expect, test } from "vitest";
import { criteriaHash } from "../catalogue";
import {
  CLASSIFIER_REQUEST_PROFILE,
  JEV_MODEL_ID,
  classifierPayloadHook,
  classifierState,
  classifierWireQuestions,
  extractClassifierText,
} from "../classifier-request";
import { matchWithNativeClassifier } from "../native-matcher";
import { suppressAlreadyNamed } from "../selection";
import type { Catalogue, Concept, Recognition } from "../types";
import { composeGlossaries, stableHash } from "../validation";
import { expectOk } from "./helpers";

const concept: Concept = {
  id: "project:testing",
  label: "property-based testing",
  alternativeLabels: ["PBT", "property-based tests"],
  domain: "testing",
  definition: "Test laws over generated inputs.",
  references: [{ kind: "web", title: "Source", url: "https://example.com" }],
};

function catalogue(...styles: Recognition["questionStyle"][]): Catalogue {
  return expectOk(
    composeGlossaries([
      {
        schemaVersion: 1,
        namespace: "project",
        concepts: styles.map((_, i) => ({ ...concept, id: `project:testing-${i}` })),
        recognition: styles.map((questionStyle, i) => ({
          conceptId: `project:testing-${i}`,
          ...(questionStyle === undefined ? {} : { questionStyle }),
          matches: "Test laws over generated inputs.",
          doesNotMatch: "Hand-picked examples or random load tests.",
          tip: "A term for this activity is property-based testing.",
        })),
      },
    ]),
  );
}

function sdkPayload(value: Catalogue) {
  return {
    model: JEV_MODEL_ID,
    state: classifierState(value, "request"),
    questions: Object.fromEntries(
      value.recognition.map((item) => [item.conceptId, { ...item.question, type: "noul" }]),
    ),
  };
}

const annotation = [
  "A pasted explanation names property-based testing and PBT.",
  "## Annotation",
  "> Please test general laws over generated inputs.",
  ">",
  "> Also check a second law.",
  "Notes: property-based testing was suggested by the assistant.",
].join("\n");

describe("classifier request profiles", () => {
  test.each(["named", "no-criteria", "structured"] as const)(
    "%s compiles the measured instruction and string-only SDK criteria",
    (style) => {
      const item = catalogue(style).recognition[0];
      expect(item?.question).toStrictEqual({
        type: "bool",
        instructions:
          'Does `user_prompt_to_coding_agent` ask for, or clearly apply, the software practice "property-based testing" (also called PBT, property-based tests) in the user\'s current request? "property-based testing" here means: Test laws over generated inputs. Judge only a request for current, real work. Hypothetical or illustrative examples, questions about what a term means, and research about a practice are not requests for it.',
        criteria: {
          true: "The current request asks for or clearly applies property-based testing: Test laws over generated inputs.",
          false:
            "The current request does not ask for property-based testing. Cases that are not property-based testing: Hand-picked examples or random load tests.",
        },
      });
    },
  );

  test("omits the alias clause when a concept has no aliases", () => {
    const value = catalogue("named");
    const item = required(value.recognition[0]);
    const withoutAliases = expectOk(
      composeGlossaries([
        {
          schemaVersion: 1,
          namespace: "project",
          concepts: [{ ...item.concept, alternativeLabels: [] }],
          recognition: [item],
        },
      ]),
    );
    expect(withoutAliases.recognition[0]?.question.instructions).not.toContain("also called");
  });

  test("transforms criteria per question, with no nonce or mutation of SDK placeholders", () => {
    const value = catalogue("named", "no-criteria", "structured", "instructions-focused");
    const payload = sdkPayload(value);
    const original = structuredClone(payload);
    const transformed = classifierPayloadHook(value)(payload);
    expect(transformed).toStrictEqual({
      ...payload,
      questions: {
        "project:testing-0": payload.questions["project:testing-0"],
        "project:testing-1": {
          type: "noul",
          instructions: value.recognition[1]?.question.instructions,
        },
        "project:testing-2": {
          type: "noul",
          instructions: value.recognition[2]?.question.instructions,
          criteria: {
            true: {
              what: "Test laws over generated inputs.",
              not_for: "Hand-picked examples or random load tests.",
            },
            false: {
              what: "The current request is outside property-based testing.",
              examples: "Hand-picked examples or random load tests.",
            },
          },
        },
        "project:testing-3": {
          ...payload.questions["project:testing-3"],
          instructions: `${value.recognition[3]?.question.instructions} Judge only a request for current, real work. Hypothetical or illustrative examples, questions about what a term means, and research about a practice are not requests for it.`,
        },
      },
    });
    expect(transformed).not.toHaveProperty("nonce");
    expect(payload).toStrictEqual(original);
  });

  test("rejects wrong models and malformed wire payloads before transport", () => {
    const value = catalogue("structured");
    const payload = sdkPayload(value);
    const question = required(payload.questions["project:testing-0"]);
    const hook = classifierPayloadHook(value);
    for (const malformed of [
      null,
      [],
      { ...payload, model: "jev-latest" },
      { ...payload, model: "jev-1.14.0" },
      { ...payload, nonce: "random" },
      { ...payload, state: null },
      { ...payload, questions: null },
      { ...payload, questions: {} },
      { ...payload, questions: { unknown: question } },
      { ...payload, questions: { ...payload.questions, extra: question } },
      ...[
        null,
        { ...question, type: "bool" },
        { ...question, instructions: "changed" },
        { ...question, criteria: {} },
        { ...question, criteria: { true: {}, false: "no" } },
        { ...question, extra: true },
      ].map((q) => ({ ...payload, questions: { "project:testing-0": q } })),
    ]) {
      expect(() => hook(malformed)).toThrow(/terminology classifier/u);
    }
  });

  test("legacy-only questions, state and hashes retain the historical contract", () => {
    const value = catalogue("instructions-focused", "with-criteria", undefined);
    const payload = sdkPayload(value);
    expect(classifierPayloadHook(value)(payload)).toStrictEqual(payload);
    expect(classifierState(value, annotation)).toStrictEqual({ prompt: annotation });
    expect(extractClassifierText(value, annotation)).toBe(annotation);
    expect(criteriaHash(value)).toBe(
      stableHash(value.recognition.map((item) => [item.conceptId, item.question])),
    );
  });

  test("new profile hashes the actual wire shape and the extraction/state profile", () => {
    const value = catalogue("structured", "no-criteria", "with-criteria");
    expect(criteriaHash(value)).toBe(
      stableHash({
        profile: CLASSIFIER_REQUEST_PROFILE,
        questions: classifierWireQuestions(value),
      }),
    );
    expect(criteriaHash(value)).not.toBe(
      stableHash(value.recognition.map((item) => [item.conceptId, item.question])),
    );
    expect(criteriaHash(value)).not.toBe(
      stableHash({
        profile: { ...CLASSIFIER_REQUEST_PROFILE, version: CLASSIFIER_REQUEST_PROFILE.version + 1 },
        questions: classifierWireQuestions(value),
      }),
    );
    // Changing a stripped placeholder must not change the policy's actual wire hash.
    const changed: Catalogue = {
      ...value,
      recognition: [
        ...value.recognition.slice(0, 2).map((item) => ({
          ...item,
          question: { ...item.question, criteria: { true: "x", false: "y" } },
        })),
        ...value.recognition.slice(2),
      ],
    };
    expect(criteriaHash(changed)).toBe(criteriaHash(value));
    expect(criteriaHash(catalogue("named"))).not.toBe(criteriaHash(catalogue("no-criteria")));
    expect(criteriaHash(catalogue("structured"))).not.toBe(criteriaHash(catalogue("no-criteria")));
  });

  test.each([
    "Remove the unused setting; the parser currently matches literal `## Annotation`.\n> Example: check that the deployed login route responds.",
    "Remove the unused setting. Example format:\n```markdown\n## Annotation\n> Check that the deployed login route responds.\n```",
    "Remove the unused setting.\n~~~text\n## Annotation\n> Deployment example.\n~~~",
    "## Annotation\nNo quoted reply exists.",
  ])("literal annotation examples and envelopes without replies retain the request: %s", (text) => {
    expect(extractClassifierText(catalogue("structured"), text)).toBe(text);
  });

  test("only extracts the actual heading section, outside fenced examples", () => {
    const text = [
      "> Unrelated quoted property-based testing text before the envelope.",
      "## Annotation",
      "> Remove the unused setting.",
      "```markdown",
      "> Unrelated fenced deployment example.",
      "```",
      "## Other context",
      "> Unrelated quoted property-based testing text after the envelope.",
    ].join("\r\n");
    expect(extractClassifierText(catalogue("structured"), text)).toBe("Remove the unused setting.");
  });

  test("extracts multiple numbered annotation sections without surrounding quotes", () => {
    const text = [
      "# Annotations",
      "## Annotation 1",
      "> First reply.",
      "## Other context",
      "> Unrelated quote.",
      "## Annotation 2",
      "> Second reply.",
    ].join("\n");
    expect(extractClassifierText(catalogue("structured"), text)).toBe(
      "First reply.\nSecond reply.",
    );
  });

  test("mixed catalogues extract replies into both state keys and do not suppress pasted names", () => {
    const value = catalogue("no-criteria", "with-criteria");
    const extracted = "Please test general laws over generated inputs.\nAlso check a second law.";
    expect(extractClassifierText(value, annotation)).toBe(extracted);
    expect(classifierState(value, annotation)).toStrictEqual({
      prompt: extracted,
      user_prompt_to_coding_agent: extracted,
    });
    expect(suppressAlreadyNamed(annotation, value).size).toBeGreaterThan(0);
    expect(suppressAlreadyNamed(extractClassifierText(value, annotation), value).size).toBe(0);
    expect(annotation).toContain("## Annotation");
    expect(extractClassifierText(value, `${annotation}\n> Apply PBT.`)).toContain("Apply PBT.");
    expect(
      suppressAlreadyNamed(extractClassifierText(value, `${annotation}\n> Apply PBT.`), value).size,
    ).toBe(2);
  });

  test.each([
    "Plain request\n> quoted but not an annotation",
    "## Annotation\nNo reply lines",
    "## Annotation\n>  \n>\nNotes only",
  ])("retains text without extractable annotation replies: %s", (text) => {
    expect(extractClassifierText(catalogue("named"), text)).toBe(text);
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Missing test fixture");
  }
  return value;
}

describe("native SDK transport", () => {
  test("the native SDK applies measured wire profiles via onPayload before the HTTP boundary", async () => {
    const value = catalogue("named", "no-criteria", "structured", "instructions-focused");
    const model: ClassifierModel<"typesafe-system-one"> = {
      type: "classifier",
      id: "jev-latest",
      name: "Jev",
      api: "typesafe-system-one",
      provider: "typesafe",
      baseUrl: "https://classifier.invalid/v1/",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 64_000,
    };
    const requests: unknown[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const body: unknown = parseRequestBody(init?.body);
      requests.push(body);
      return new Response(
        JSON.stringify({
          answers: Object.fromEntries(
            value.recognition.map((item) => [item.conceptId, { type: "noul", noul: 0.91 }]),
          ),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    await expect(
      matchWithNativeClassifier(
        {
          findOfType: () => model,
          classify: async (pinned, context, options) =>
            classify({ ...model, id: pinned.id }, context, {
              ...options,
              apiKey: "test-only",
              fetch,
            }),
        },
        value,
        annotation,
        0.9,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(requests).toStrictEqual([
      {
        model: JEV_MODEL_ID,
        state: classifierState(value, annotation),
        questions: classifierWireQuestions(value),
      },
    ]);
  });
});

function parseRequestBody(body: RequestInit["body"]): unknown {
  if (typeof body !== "string") {
    throw new TypeError("Expected a JSON request body");
  }
  return JSON.parse(body);
}
