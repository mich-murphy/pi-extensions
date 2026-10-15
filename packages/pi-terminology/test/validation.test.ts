import { describe, expect, test } from "vitest";
import { criteriaHash, isPolicy } from "../catalogue";
import type { Policy, Recognition } from "../types";
import { composeGlossaries, normalizeLabel, parseGlossary } from "../validation";
import { expectErr, expectOk } from "./helpers";

const document = {
  schemaVersion: 1,
  namespace: "project",
  concepts: [
    {
      id: "project:one",
      label: "Property  Based Testing",
      domain: "testing",
      definition: "A useful definition.",
      alternativeLabels: ["PBT"],
      references: [{ kind: "web", title: "Source", url: "https://example.com" }],
      relatedConceptIds: ["project:two"],
    },
    {
      id: "project:two",
      label: "Other",
      domain: "testing",
      definition: "Another useful definition.",
      references: [
        { kind: "book", title: "Book", authors: ["A"], edition: "1", locator: "chapter" },
      ],
    },
  ],
  recognition: [
    {
      conceptId: "project:one",
      matches: "Generated inputs",
      doesNotMatch: "Examples",
      tip: "A term for this activity is property-based testing.",
    },
  ],
};

function styledCatalogue(questionStyle?: Recognition["questionStyle"]) {
  const parsed = expectOk(
    parseGlossary(
      {
        ...document,
        recognition: document.recognition.map((item) => ({
          ...item,
          ...(questionStyle === undefined ? {} : { questionStyle }),
        })),
      },
      "test",
    ),
  );
  return expectOk(composeGlossaries([parsed]));
}

describe("terminology validation", () => {
  test("defaults legacy recognizers to direct statements with aligned criteria", () => {
    const catalogue = styledCatalogue();
    expect(catalogue.recognition[0]?.question).toStrictEqual({
      type: "bool",
      instructions: "Generated inputs",
      criteria: { true: "Generated inputs", false: "Examples" },
    });
    expect(criteriaHash(catalogue)).toBe(criteriaHash(styledCatalogue("with-criteria")));
  });

  test("instructions-focused includes both boundaries and minimal SDK-required criteria", () => {
    const catalogue = styledCatalogue("instructions-focused");
    const question = catalogue.recognition[0]?.question;
    expect(question).toStrictEqual({
      type: "bool",
      instructions: "Generated inputs Non-matching boundary: Examples",
      criteria: { true: "The request matches.", false: "The request does not match." },
    });
    expect(catalogue.recognition[0]?.questionStyle).toBe("instructions-focused");
    expect(catalogue.hash).not.toBe(styledCatalogue("with-criteria").hash);
    expect(criteriaHash(catalogue)).not.toBe(criteriaHash(styledCatalogue("with-criteria")));
  });

  test("styles are per recognizer, not a global catalogue override", () => {
    const catalogue = expectOk(
      composeGlossaries([
        expectOk(
          parseGlossary(
            {
              ...document,
              recognition: [
                { ...document.recognition[0], questionStyle: "instructions-focused" },
                {
                  conceptId: "project:two",
                  matches: "Different activity",
                  doesNotMatch: "Different boundary",
                  tip: "Other term",
                },
              ],
            },
            "mixed",
          ),
        ),
      ]),
    );
    expect(catalogue.recognition[0]?.question).toStrictEqual({
      type: "bool",
      instructions: "Generated inputs Non-matching boundary: Examples",
      criteria: { true: "The request matches.", false: "The request does not match." },
    });
    expect(catalogue.recognition[1]?.question).toStrictEqual({
      type: "bool",
      instructions: "Different activity",
      criteria: { true: "Different activity", false: "Different boundary" },
    });
  });

  test.each([
    "instructions-focused",
    "with-criteria",
    "named",
    "no-criteria",
    "structured",
  ] as const)(
    "binds raw boundaries to catalogue identity and actual wire text to criteria identity: %s",
    (questionStyle) => {
      const original = styledCatalogue(questionStyle);
      for (const field of ["matches", "doesNotMatch"] as const) {
        const changed = expectOk(
          composeGlossaries([
            expectOk(
              parseGlossary(
                {
                  ...document,
                  recognition: document.recognition.map((item) => ({
                    ...item,
                    questionStyle,
                    [field]: `${item[field]} changed`,
                  })),
                },
                "changed",
              ),
            ),
          ]),
        );
        expect(changed.hash).not.toBe(original.hash);
        const sameWire = ["no-criteria:doesNotMatch"].includes(`${questionStyle}:${field}`);
        expect(criteriaHash(changed) === criteriaHash(original)).toBe(sameWire);
      }
    },
  );

  test.each(["other", "", "with-criteria\u001B", "with-criteria\u202E", null, false, 1, {}])(
    "rejects unsupported question styles without interpolating unsafe values: %j",
    (questionStyle) => {
      const errors = expectErr(
        parseGlossary(
          {
            ...document,
            recognition: document.recognition.map((item) => ({ ...item, questionStyle })),
          },
          "bad",
        ),
      );
      const text = errors.join("\n");
      expect(text).toContain("questionStyle must be instructions-focused or with-criteria");
      expect(text).not.toContain("\u001B");
      expect(text).not.toContain("\u202E");
    },
  );

  test.each([
    "instructions-focused",
    "with-criteria",
    "named",
    "no-criteria",
    "structured",
  ] as const)("still rejects unsafe recognition text for %s", (questionStyle) => {
    const errors = expectErr(
      parseGlossary(
        {
          ...document,
          recognition: document.recognition.map((item) => ({
            ...item,
            questionStyle,
            matches: "generated\u0085inputs",
            doesNotMatch: "examples\u2028only",
            extra: true,
          })),
        },
        "bad",
      ),
    );
    expect(errors.join("\n")).toContain("unknown field extra");
    expect(errors.join("\n")).toContain("unsafe control or bidi text");
  });
  test("normalizes equivalent labels", () => {
    expect(normalizeLabel(" Property　Based   Testing ")).toBe("property based testing");
  });

  test("composes valid glossary documents", () => {
    const parsed = expectOk(parseGlossary(document, "test"));
    const composed = expectOk(composeGlossaries([parsed]));
    expect(composed.recognition).toHaveLength(1);
  });

  test("allows safe non-core namespaces and rejects nested core namespace bypasses", () => {
    expectOk(
      parseGlossary(
        {
          ...document,
          namespace: "team-7",
          concepts: [
            {
              ...document.concepts[0],
              id: "team-7:local-term",
              relatedConceptIds: undefined,
            },
          ],
          recognition: [],
        },
        "good",
      ),
    );

    const nestedCore = expectErr(
      parseGlossary(
        {
          ...document,
          namespace: "core:other",
          concepts: [{ ...document.concepts[0], id: "core:other:term" }],
          recognition: [],
        },
        "bad",
      ),
    );
    expect(nestedCore.join("\n")).toContain(
      "namespace must use lowercase ASCII letters, digits or hyphens",
    );

    const coreId = expectErr(
      parseGlossary(
        {
          ...document,
          namespace: "project",
          concepts: [{ ...document.concepts[0], id: "core:other-term" }],
          recognition: [],
        },
        "bad",
      ),
    );
    expect(coreId.join("\n")).toContain("cannot define reserved core concept ID core:other-term");
  });

  test("rejects unknown fields and unsafe urls", () => {
    const unsafeKey = "extra\u001B[31m\u202E";
    const errors = expectErr(
      parseGlossary(
        {
          ...document,
          extra: true,
          [unsafeKey]: true,
          concepts: [
            {
              ...document.concepts[0],
              references: [{ kind: "web", title: "Bad", url: "file:///tmp/x" }],
            },
          ],
        },
        "bad",
      ),
    );
    const text = errors.join("\n");
    expect(text).toContain("unknown field extra");
    expect(text).toContain(String.raw`unknown field extra\u001B[31m\u202E`);
    expect(text).not.toContain("\u001B");
    expect(text).not.toContain("\u202E");
    expect(text).toContain("must use http or https");

    const malformed = expectErr(
      parseGlossary(
        {
          ...document,
          concepts: [
            {
              ...document.concepts[0],
              references: [{ kind: "web", title: "Bad", url: "https://user:pass@example.com" }],
            },
          ],
        },
        "bad",
      ),
    );
    expect(malformed.join("\n")).toContain("must not include username or password");
  });

  test("rejects project core namespace and unsafe visible text", () => {
    expect(
      expectErr(parseGlossary({ ...document, namespace: "core" }, "bad")).join("\n"),
    ).toContain("reserved core namespace");
    const errors = expectErr(
      parseGlossary(
        {
          ...document,
          concepts: [{ ...document.concepts[0], definition: "safe\u202Eunsafe" }],
        },
        "bad",
      ),
    );
    expect(errors.join("\n")).toContain("unsafe control or bidi text");

    const namespace = parseGlossary(
      { schemaVersion: 1, namespace: "project\u202E", concepts: [], recognition: [] },
      "bad",
    );
    expect(namespace.ok).toBe(false);
  });

  test("rejects C1 and line separator controls without rejecting legitimate Unicode", () => {
    const c1 = expectErr(
      parseGlossary(
        {
          ...document,
          concepts: [{ ...document.concepts[0], label: "bad\u0085label" }],
        },
        "bad",
      ),
    );
    expect(c1.join("\n")).toContain("unsafe control or bidi text");

    const lineSeparator = expectErr(
      parseGlossary(
        {
          ...document,
          concepts: [{ ...document.concepts[0], definition: "bad\u2028line" }],
        },
        "bad",
      ),
    );
    expect(lineSeparator.join("\n")).toContain("unsafe control or bidi text");

    expectOk(
      parseGlossary(
        {
          ...document,
          concepts: [{ ...document.concepts[0], label: "👩‍💻 property testing" }],
        },
        "good",
      ),
    );
  });

  test("rejects collisions and dangling related links", () => {
    const parsed = expectOk(
      parseGlossary(
        {
          ...document,
          concepts: [{ ...document.concepts[0], relatedConceptIds: ["project:missing"] }],
          recognition: [],
        },
        "bad",
      ),
    );
    const errors = expectErr(composeGlossaries([parsed]));
    expect(errors.join("\n")).toContain("related concept project:missing is missing");

    const duplicate = expectErr(
      composeGlossaries([
        expectOk(
          parseGlossary(
            {
              ...document,
              concepts: [
                { ...document.concepts[0], relatedConceptIds: ["project:one", "project:one"] },
              ],
              recognition: [],
            },
            "bad",
          ),
        ),
      ]),
    );
    expect(duplicate.join("\n")).toContain("related concept IDs must be distinct");
  });
});

function measuredPolicy(style?: Recognition["questionStyle"]) {
  const catalogue = styledCatalogue(style);
  const policy: Policy = {
    schemaVersion: 1,
    model: "jev-1.13.0",
    catalogueHash: catalogue.hash,
    criteriaHash: criteriaHash(catalogue),
    fixtureHash: "b".repeat(64),
    threshold: 0.85,
    measuredDisplayedPrecision: 0.95,
    measured: true,
  };
  return { catalogue, policy };
}

describe("profile policy validation", () => {
  test("keeps legacy policies valid without optional fields and preserves historical precision", () => {
    const { catalogue, policy } = measuredPolicy("instructions-focused");
    expect(isPolicy(policy, catalogue)).toBe(true);
    expect(isPolicy({ ...policy, measuredDisplayedPrecision: 0.94 }, catalogue)).toBe(false);
    expect(
      isPolicy({ ...policy, precisionTarget: 0.9, measuredDisplayedPrecision: 0.9 }, catalogue),
    ).toBe(true);
  });

  test.each(["named", "no-criteria", "structured"] as const)(
    "%s measured policies require a full exact per-concept map",
    (style) => {
      const { catalogue, policy } = measuredPolicy(style);
      expect(isPolicy(policy, catalogue)).toBe(false);
      const complete = { ...policy, conceptThresholds: { "project:one": 0.91 } };
      expect(isPolicy(complete, catalogue)).toBe(true);
      expect(isPolicy({ ...complete, criteriaHash: "a".repeat(64) }, catalogue)).toBe(false);
      expect(isPolicy({ ...complete, catalogueHash: "a".repeat(64) }, catalogue)).toBe(false);
      expect(isPolicy({ ...complete, fixtureHash: "pending" }, catalogue)).toBe(false);
    },
  );

  test.each([undefined, "no-criteria"] as const)(
    "validates any provided threshold map, including legacy catalogues: %s",
    (style) => {
      const { catalogue, policy } = measuredPolicy(style);
      for (const conceptThresholds of [
        null,
        [],
        0.91,
        {},
        { "project:two": 0.91 },
        { "project:one": 0.91, "project:two": 0.91 },
        ...[0, -0.1, 1.01, Number.NaN, Infinity, "0.91", null].map((value) => ({
          "project:one": value,
        })),
      ]) {
        expect(isPolicy({ ...policy, conceptThresholds }, catalogue)).toBe(false);
      }
      for (const cutoff of [0.001, 0.85, 0.9, 0.91, 1]) {
        expect(
          isPolicy({ ...policy, conceptThresholds: { "project:one": cutoff } }, catalogue),
        ).toBe(true);
      }
    },
  );

  test("precision targets are finite, at least .90, and enforced on measured policies", () => {
    const { catalogue, policy } = measuredPolicy("named");
    const complete = { ...policy, conceptThresholds: { "project:one": 0.91 } };
    for (const precisionTarget of [0, 0.89, 1.01, Number.NaN, Infinity, "0.9", null]) {
      expect(isPolicy({ ...complete, precisionTarget }, catalogue)).toBe(false);
    }
    for (const precisionTarget of [0.9, 0.91, 0.95, 1]) {
      expect(
        isPolicy(
          { ...complete, precisionTarget, measuredDisplayedPrecision: precisionTarget },
          catalogue,
        ),
      ).toBe(true);
      expect(
        isPolicy(
          { ...complete, precisionTarget, measuredDisplayedPrecision: precisionTarget - 0.001 },
          catalogue,
        ),
      ).toBe(false);
    }
  });

  test.each(["named", "no-criteria", "structured"] as const)(
    "preserves %s through parsing and binds it and labels to catalogue/hash identity",
    (style) => {
      const original = styledCatalogue(style);
      expect(original.recognition[0]?.questionStyle).toBe(style);
      expect(original.hash).not.toBe(styledCatalogue("with-criteria").hash);
      for (const change of [{ label: "Renamed practice" }, { alternativeLabels: ["New alias"] }]) {
        const changed = expectOk(
          composeGlossaries([
            expectOk(
              parseGlossary(
                {
                  ...document,
                  concepts: document.concepts.map((item) => ({ ...item, ...change })),
                  recognition: document.recognition.map((item) => ({
                    ...item,
                    questionStyle: style,
                  })),
                },
                "changed",
              ),
            ),
          ]),
        );
        expect(changed.hash).not.toBe(original.hash);
        expect(criteriaHash(changed)).not.toBe(criteriaHash(original));
      }
    },
  );
});
