import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, assert, describe, expect, test } from "vitest";
import { loadCatalogue } from "../catalogue";
import { findProjectGlossary, readApprovedProjectGlossary } from "../project";
import { TerminologyStateStore } from "../state";

const roots: string[] = [];

function tempRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), name));
  roots.push(root);
  return root;
}

function makeRepo(name = "terms-project-"): string {
  const root = tempRoot(name);
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".pi"));
  return root;
}

function readSavedState(text: string): { readonly approvedGlossaries: readonly string[] } {
  const parsed: unknown = JSON.parse(text);
  assert(isRecord(parsed));
  const glossaries = parsed.approvedGlossaries;
  assert(Array.isArray(glossaries));
  assert(glossaries.every((item) => typeof item === "string"));
  return { approvedGlossaries: glossaries };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function glossary(namespace: string, concept = "one"): string {
  return JSON.stringify({
    schemaVersion: 1,
    namespace,
    concepts: [
      {
        id: `${namespace}:${concept}`,
        label: "Project term",
        domain: "testing",
        definition: "A project-specific definition.",
        references: [{ kind: "web", title: "Project source", url: "https://example.com" }],
      },
    ],
    recognition: [
      {
        conceptId: `${namespace}:${concept}`,
        matches: "project-specific behavior",
        doesNotMatch: "other behavior",
        tip: "A term for this activity is project term.",
      },
    ],
  });
}

describe("terminology project discovery and state", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("discovers only the nearest Git root and reuses path approval across content edits", () => {
    const root = makeRepo();
    const nested = join(root, "src", "feature");
    mkdirSync(nested, { recursive: true });
    const path = join(root, ".pi", "terminology.json");
    writeFileSync(path, glossary("project"));
    const candidate = findProjectGlossary(nested);
    expect(candidate).toMatchObject({
      repoRoot: realpathSync(root),
      canonicalPath: realpathSync(path),
    });
    assert(candidate !== undefined, "expected project glossary candidate");
    expect(readApprovedProjectGlossary(candidate, new Set())).toBeUndefined();
    const approved = new Set([candidate.canonicalPath]);
    expect(readApprovedProjectGlossary(candidate, approved)).toContain("project:one");
    writeFileSync(path, glossary("project", "edited"));
    expect(readApprovedProjectGlossary(candidate, approved)).toContain("project:edited");
  });

  test("uses current directory only when no Git root exists", () => {
    const root = tempRoot("terms-nongit-");
    mkdirSync(join(root, ".pi"));
    writeFileSync(join(root, ".pi", "terminology.json"), glossary("project"));
    mkdirSync(join(root, "child"));
    expect(findProjectGlossary(root)?.canonicalPath).toBe(
      realpathSync(join(root, ".pi", "terminology.json")),
    );
    expect(findProjectGlossary(join(root, "child"))).toBeUndefined();
  });

  test("ignores home, root, ancestor and symlink-escaped candidates", () => {
    const root = makeRepo();
    const outside = tempRoot("terms-outside-");
    const homeChild = join(homedir(), "terms-no-git-subdir");
    mkdirSync(join(root, "child"));
    writeFileSync(join(outside, "terminology.json"), glossary("project"));
    rmSync(join(root, ".pi", "terminology.json"), { force: true });
    symlinkSync(join(outside, "terminology.json"), join(root, ".pi", "terminology.json"));
    expect(findProjectGlossary(join(root, "child"))).toBeUndefined();
    expect(findProjectGlossary(homeChild)).toBeUndefined();
    expect(findProjectGlossary(resolve("/"))).toBeUndefined();
  });

  test("stores preferences atomically and falls back after corrupt state", () => {
    const root = tempRoot("terms-state-");
    const path = join(root, "state.json");
    const store = new TerminologyStateStore(path);
    store.approveGlossary("/repo/.pi/terminology.json");
    store.hideConcept("core:refactoring");
    store.setCooldown("core:refactoring", 123);
    const saved = readSavedState(readFileSync(path, "utf8"));
    expect(saved.approvedGlossaries).toStrictEqual(["/repo/.pi/terminology.json"]);
    expect(store.load().hiddenConceptIds.has("core:refactoring")).toBe(true);
    expect(store.load().cooldowns.get("core:refactoring")).toBe(123);
    writeFileSync(path, "not json");
    expect(() => store.load()).toThrow("Unexpected token");
    const replacement = join(root, "replacement.json");
    writeFileSync(replacement, JSON.stringify({ version: 99 }));
    renameSync(replacement, path);
    expect(store.load().approvedGlossaries.size).toBe(0);
  });

  test("does not read bytes after a symlink is retargeted to an unapproved file", () => {
    const root = makeRepo();
    const first = join(root, "glossaries", "first.json");
    const second = join(root, "glossaries", "second.json");
    mkdirSync(join(root, "glossaries"));
    writeFileSync(first, glossary("project", "approved"));
    writeFileSync(second, glossary("project", "unapproved"));
    rmSync(join(root, ".pi", "terminology.json"), { force: true });
    symlinkSync(first, join(root, ".pi", "terminology.json"));
    const approved = findProjectGlossary(root);
    assert(approved !== undefined, "expected approved symlink");
    rmSync(join(root, ".pi", "terminology.json"));
    symlinkSync(second, join(root, ".pi", "terminology.json"));
    const retargeted = findProjectGlossary(root);
    assert(retargeted !== undefined, "expected retargeted symlink");
    expect(
      readApprovedProjectGlossary(retargeted, new Set([approved.canonicalPath])),
    ).toBeUndefined();
  });

  test("keeps project criteria browsable but unmeasured for automatic reminders", () => {
    const loaded = loadCatalogue(glossary("project"));
    assert(loaded.ok, "expected project catalogue to load");
    expect(loaded.catalogue.concepts.some((concept) => concept.id === "project:one")).toBe(true);
    expect(loaded.policy.measured).toBe(false);
    expect(loaded.warning).toContain("not been measured");
  });
});
