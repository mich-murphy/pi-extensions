import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { instructionHeading, readInstructionHeading } from "../instruction-heading";

const directories: string[] = [];

describe("instruction headings", () => {
  afterEach(() => {
    for (const path of directories.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test.each([
    ["# Working Agreement\nBody", "Working Agreement"],
    ["\uFEFF## Agent development ##\r\nBody", "Agent development"],
    ["Working Agreement\n=================\nBody", "Working Agreement"],
    ["Working Agreement\n-----------------\nBody", "Working Agreement"],
    ["---\ntitle: frontmatter\n---\n# Source heading", "Source heading"],
    ["---\ntitle: frontmatter\n...\n# Source heading", "Source heading"],
    ["```md\n# Example\n```\n# Real heading", "Real heading"],
    ["~~~~\n# Example\n```\n~~~~\n# Real heading", "Real heading"],
    ["<!--\n# Hidden\n-->\n# Visible", "Visible"],
    ["<!-- # Hidden -->\n# Visible", "Visible"],
    ["    # Code\n# Visible", "Visible"],
    ["# AGENTS.md\n# Later", ""],
    ["# agents.MD", ""],
    ["No heading", ""],
    ["---\nunclosed: metadata\n# Not a heading", ""],
  ])("extracts source text from %j", (content, expected) => {
    expect(instructionHeading(content, "/repo/AGENTS.md")).toBe(expected);
  });

  test("reads a bounded prefix and treats unavailable metadata as optional", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-heading-"));
    directories.push(directory);
    const path = join(directory, "AGENTS.md");
    writeFileSync(path, `# Exact source title\n${"body\n".repeat(20_000)}`);
    await expect(readInstructionHeading(path)).resolves.toBe("Exact source title");
    await expect(readInstructionHeading(join(directory, "missing.md"))).resolves.toBe("");
    writeFileSync(path, `${"body\n".repeat(20_000)}# Too late\n`);
    await expect(readInstructionHeading(path)).resolves.toBe("");
  });
});
