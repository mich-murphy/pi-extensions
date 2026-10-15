import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { criteriaHash, loadCatalogue } from "../catalogue";
import { extractClassifierText } from "../classifier-request";
import { runCli } from "../scripts/evaluate";
import type { EvalCliDependencies } from "../scripts/evaluate";
import { suppressAlreadyNamed } from "../selection";
import { composeGlossaries, parseGlossary } from "../validation";
import { expectOk } from "./helpers";

const source: unknown = JSON.parse(
  readFileSync(new URL("../glossary/core.json", import.meta.url), "utf8"),
);
const document = expectOk(parseGlossary(source, "production", "core"));

describe("production catalogue integration", () => {
  test("keeps recognition cues separate from glossary synonyms and suppresses already-used cues", () => {
    const { catalogue } = loadCatalogue();
    const concept = catalogue.concepts.find((item) => item.id === "core:accidental-complexity");
    const recognizer = catalogue.recognition.find(
      (item) => item.conceptId === "core:accidental-complexity",
    );
    expect(concept?.alternativeLabels).not.toContain("KISS");
    expect(recognizer?.question.instructions).toContain("KISS");
    expect(suppressAlreadyNamed("Apply KISS to this implementation.", catalogue)).toContain(
      "core:accidental-complexity",
    );
    const prompt =
      '# Annotations\n## Annotation 1\nComment on: "Apply KISS"\n> Please remove the needless indirection.';
    const text = extractClassifierText(catalogue, prompt);
    expect(text).toBe("Please remove the needless indirection.");
    expect(suppressAlreadyNamed(text, catalogue)).not.toContain("core:accidental-complexity");
  });

  test.each([
    { classifierAliases: "KISS" },
    { classifierAliases: [] },
    { classifierAliases: ["KISS", "kiss"] },
    { classifierAliases: ["unsafe\u001btext"] },
  ])("rejects invalid recognition alias lists: %j", ({ classifierAliases }) => {
    const changed = {
      ...document,
      recognition: document.recognition.map((item) => ({ ...item, classifierAliases })),
    };
    expect(parseGlossary(changed, "changed", "core").ok).toBe(false);
  });

  test("hashes valid classifier aliases into the catalogue and compiled question", () => {
    const changed = {
      ...document,
      recognition: document.recognition.map((item) => ({
        ...item,
        classifierAliases: ["different recognition cue"],
      })),
    };
    const parsed = expectOk(parseGlossary(changed, "changed", "core"));
    expect(parsed.recognition.at(-1)?.classifierAliases).toStrictEqual([
      "different recognition cue",
    ]);
    const changedCatalogue = expectOk(composeGlossaries([parsed]));
    const { catalogue } = loadCatalogue();
    expect(changedCatalogue.hash).not.toBe(catalogue.hash);
    expect(criteriaHash(changedCatalogue)).not.toBe(criteriaHash(catalogue));
  });

  test("historical evaluator refuses the expanded production profile without constructing credentials", async () => {
    const createRegistry = vi.fn<EvalCliDependencies["createRegistry"]>(async () => {
      throw new Error("Credentials must not be constructed");
    });
    const stderr = { write: vi.fn<(message: string | Uint8Array) => boolean>(() => true) };
    const result = await runCli(["--split", "development", "--dry-run"], {
      agentDir: () => "/unused-terminology-test",
      stdout: { write: () => true },
      stderr,
      runId: () => "offline",
      now: () => new Date(0),
      createRegistry,
      matcher: async () => {
        throw new Error("No dispatch permitted");
      },
    });
    expect(result).toBe(1);
    expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining("verify-production.ts"));
    expect(createRegistry).not.toHaveBeenCalled();
  });
});
