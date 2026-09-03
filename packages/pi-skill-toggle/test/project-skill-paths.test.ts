import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { discoverProjectSkillPaths } from "../project-skill-paths";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-project-skills-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("discoverProjectSkillPaths", () => {
  test("finds common agent skill directories from cwd through the Git root", () => {
    const root = temporaryDirectory();
    const cwd = join(root, "apps", "web");
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".claude", "skills"), { recursive: true });
    mkdirSync(join(root, ".codex", "skills"), { recursive: true });
    mkdirSync(join(root, ".agents", "skills"), { recursive: true });
    mkdirSync(join(cwd, ".pi", "skills"), { recursive: true });

    expect(discoverProjectSkillPaths(cwd)).toEqual([
      join(cwd, ".pi", "skills"),
      join(root, ".agents", "skills"),
      join(root, ".claude", "skills"),
      join(root, ".codex", "skills"),
    ]);
  });

  test("does not search ancestors when cwd is outside a Git worktree", () => {
    const parent = temporaryDirectory();
    const cwd = join(parent, "project");
    mkdirSync(join(parent, ".claude", "skills"), { recursive: true });
    mkdirSync(join(cwd, ".codex", "skills"), { recursive: true });

    expect(discoverProjectSkillPaths(cwd)).toEqual([join(cwd, ".codex", "skills")]);
  });
});
