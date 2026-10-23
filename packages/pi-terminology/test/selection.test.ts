import { describe, expect, test } from "vitest";
import { loadCatalogue } from "../catalogue";
import { selectMatches, suppressAlreadyNamed } from "../selection";
import type { Catalogue, Match } from "../types";

const concept = {
  id: "core:test-driven-development",
  label: "test-driven development",
  domain: "testing",
  definition: "definition",
  alternativeLabels: ["TDD", "red-green-refactor"],
  references: [{ kind: "web", title: "Source", url: "https://example.com" }],
} as const;
const recognition = {
  conceptId: concept.id,
  matches: "write failing test first",
  doesNotMatch: "tests later",
  tip: "A term for this activity is test-driven development.",
  concept,
  question: {
    type: "bool",
    instructions: "Does it match?",
    criteria: { true: "yes", false: "no" },
  },
} as const;
const mutationConcept = {
  id: "core:mutation-testing",
  label: "mutation testing",
  domain: "testing",
  definition: "definition",
  references: [{ kind: "web", title: "Source", url: "https://example.com" }],
} as const;
const catalogue: Catalogue = {
  concepts: [concept, mutationConcept],
  recognition: [recognition],
  hash: "hash",
};
const match: Match = { concept, recognition, probability: 0.99, tip: recognition.tip };

describe("terminology selection", () => {
  test.each([
    "Add a property-based test for parser",
    "Use property-based testing for the parser",
    "Use property-based tests for the parser",
    "Add PROPERTY-BASED TESTS for the parser",
    "Use property based tests for the parser",
    "Use property/based/tests for the parser",
    "Use property–based tests for the parser",
    'Apply "property-based tests" to the parser',
    "Adopt `property-based tests` for the parser",
    "Use 'property-based tests' for the parser",
    'Apply "property-based test" to the parser',
    "Adopt `property-based test` for the parser",
    "Use 'property-based test' for the parser",
  ])("suppresses the verified bundled PBT labels: %s", (prompt) => {
    expect(suppressAlreadyNamed(prompt, loadCatalogue().catalogue)).toContain(
      "core:property-based-testing",
    );
  });

  test.each([
    "Avoid `property-based tests` here",
    'Do not apply "property-based tests" here',
    "The note says 'property-based tests' historically",
    'The note says "use property-based tests" historically',
    "Previously we used property-based tests here",
    "We formerly called these property-based tests",
    "The log's `property-based tests` label is just old text",
    "Avoid `property-based test` here",
    'Do not apply "property-based test" here',
    "The note says 'property-based test' historically",
    'The note says "use property-based test" historically',
    "Previously we used a property-based test here",
    "We formerly called this a property-based test",
    "The log's `property-based test` label is just old text",
  ])("does not suppress quoted or historical PBT aliases: %s", (prompt) => {
    expect(suppressAlreadyNamed(prompt, loadCatalogue().catalogue)).not.toContain(
      "core:property-based-testing",
    );
  });

  test.each([
    "Generate inputs and check general correctness properties",
    "Add property-based testsmanship",
    "Add a property-based tester",
    "Add a property-based testament",
    "Add tests of properties",
  ])("does not invent unnamed or stemmed PBT aliases: %s", (prompt) => {
    expect(suppressAlreadyNamed(prompt, loadCatalogue().catalogue)).not.toContain(
      "core:property-based-testing",
    );
  });
  test.each([
    "Use TDD for this feature",
    "Use red-green-refactor for this feature",
    "Use red/green/refactor for this feature",
    "Use red green refactor for this feature",
    "Use RED/GREEN/REFACTOR for this feature",
    "Use `TDD` for this feature",
    'Use "TDD" for this feature',
    "Use 'TDD' for this feature",
    "Let's use TDD; it's appropriate",
  ])("suppresses affirmative already named terms: %s", (prompt) => {
    expect(suppressAlreadyNamed(prompt, catalogue)).toContain(concept.id);
  });

  test("suppresses affirmative quoted labels for their own concept", () => {
    expect(suppressAlreadyNamed('Use "mutation testing" on this module', catalogue)).toContain(
      mutationConcept.id,
    );
  });

  test.each([
    "Do not use property-based tests; just fix docs",
    "Add generated correctness checks, not property-based tests",
    "Do not add a property-based test; just fix docs",
    "Add generated correctness checks, not a property-based test",
  ])("does not repeat terms explicitly named in current negative requests: %s", (prompt) => {
    expect(suppressAlreadyNamed(prompt, loadCatalogue().catalogue)).toContain(
      "core:property-based-testing",
    );
  });

  test("suppresses explicit negative requests but not quoted or historical context", () => {
    expect(suppressAlreadyNamed("Do not use TDD; just fix docs", catalogue)).toContain(concept.id);
    expect(suppressAlreadyNamed("Do not use `TDD`; just fix docs", catalogue)).not.toContain(
      concept.id,
    );
    expect(suppressAlreadyNamed("Avoid red/green/refactor here", catalogue)).toContain(concept.id);
    expect(suppressAlreadyNamed("The note says 'TDD' historically", catalogue)).not.toContain(
      concept.id,
    );
    expect(suppressAlreadyNamed('The note says "use TDD" historically', catalogue)).not.toContain(
      concept.id,
    );
    expect(suppressAlreadyNamed("The note says ‘red/green/refactor’", catalogue)).not.toContain(
      concept.id,
    );
    expect(suppressAlreadyNamed("Previously we used TDD here", catalogue)).not.toContain(
      concept.id,
    );
  });

  test("suppresses the known redundant reminder for avoiding accidental complexity", () => {
    expect(
      suppressAlreadyNamed("Avoid accidental complexity.", loadCatalogue().catalogue),
    ).toContain("core:accidental-complexity");
  });

  test("abstains when selected matches share an ambiguous label", () => {
    const otherConcept = { ...concept, id: "project:test-driven-development", domain: "other" };
    const otherRecognition = { ...recognition, conceptId: otherConcept.id, concept: otherConcept };
    const otherMatch: Match = {
      concept: otherConcept,
      recognition: otherRecognition,
      probability: 0.99,
      tip: recognition.tip,
    };
    expect(
      selectMatches(
        [match, otherMatch],
        { hiddenConceptIds: new Set(), dismissedConceptIds: new Set(), cooldowns: new Map() },
        10,
        new Set(),
      ),
    ).toHaveLength(0);
  });

  test("filters hidden and cooldown concepts", () => {
    const selected = selectMatches(
      [match],
      {
        hiddenConceptIds: new Set(),
        dismissedConceptIds: new Set(),
        cooldowns: new Map([[concept.id, 20]]),
      },
      10,
      new Set(),
    );
    expect(selected).toHaveLength(0);
  });
});
