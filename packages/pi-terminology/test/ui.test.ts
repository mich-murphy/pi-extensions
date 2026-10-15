import { describe, expect, test } from "vitest";
import type { Catalogue, Match } from "../types";
import { browseText, createTerminologyBrowser, renderReminder } from "../ui";

const source = { kind: "web", title: "Fowler", url: "https://martinfowler.com" } as const;
const concept = {
  id: "core:refactoring",
  label: "refactoring",
  domain: "design",
  definition: "Internal restructuring without observable behavior changes.",
  alternativeLabels: ["cleanup"],
  relatedConceptIds: ["core:mutation-testing"],
  references: [source],
} as const;
const related = {
  id: "core:mutation-testing",
  label: "mutation testing",
  domain: "testing",
  definition: "Changing production code to see if tests fail.",
  references: [
    { kind: "book", title: "Book", authors: ["A", "B"], edition: "1st", locator: "ch 1" },
  ],
} as const;
const recognition = {
  conceptId: concept.id,
  matches: "internal",
  doesNotMatch: "external",
  tip: "A term for this activity is refactoring.",
  concept,
  question: {
    type: "bool",
    instructions: "Does it match?",
    criteria: { true: "yes", false: "no" },
  },
} as const;
const match: Match = { concept, recognition, probability: 0.99, tip: recognition.tip };
const catalogue: Catalogue = {
  concepts: [concept, related],
  recognition: [recognition],
  hash: "hash",
};

describe("terminology UI", () => {
  test("renders grouped reminder with bounded overflow count", () => {
    expect(renderReminder([match])[0]).toContain("refactoring");
    expect(renderReminder([match, match, match, match])[0]).toContain("+1 more");
  });

  test("browses details without auth and searches aliases and source fields", () => {
    expect(browseText(catalogue, "cleanup", [match])).toContain("Fixed tip");
    expect(browseText(catalogue, "fowler")).toContain("Internal restructuring");
    expect(browseText(catalogue, "mutation")).toContain("Authors: A, B");
  });

  test("custom browser keeps q as query text, uses escape to close and navigates related labels", () => {
    let renders = 0;
    let closed = false;
    const browser = createTerminologyBrowser(
      {
        requestRender: () => {
          renders += 1;
        },
      },
      catalogue,
      "",
      [match],
      () => {
        closed = true;
      },
    );
    browser.handleInput?.("q");
    expect(browser.render(80).join("\n")).toContain("Matches for “q”");
    expect(closed).toBe(false);
    browser.handleInput?.("\u001B");
    expect(closed).toBe(false);
    browser.handleInput?.("\r");
    expect(browser.render(80).join("\n")).toContain("mutation testing");
    browser.handleInput?.("\u001B");
    expect(closed).toBe(false);
    browser.handleInput?.("\u001B");
    expect(closed).toBe(true);
    expect(renders).toBeGreaterThan(0);
  });
});
