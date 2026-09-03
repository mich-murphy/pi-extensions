import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, loadSkills } from "@earendil-works/pi-coding-agent";
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

function writeSkill(root: string, directory: string, name: string): string {
  const path = join(root, directory, "SKILL.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\nname: ${name}\ndescription: ${name} description\n---\n`);
  return path;
}

describe("discoverProjectSkillPaths", () => {
  test("finds individual skills from cwd through the Git root", () => {
    const root = temporaryDirectory();
    const cwd = join(root, "apps", "web");
    mkdirSync(join(root, ".git"));
    const local = writeSkill(join(cwd, ".pi", "skills"), "local", "local");
    const shared = writeSkill(join(root, ".agents", "skills"), "shared", "shared");
    const claude = writeSkill(join(root, ".claude", "skills"), "claude", "claude");
    const codex = writeSkill(join(root, ".codex", "skills"), "codex", "codex");

    expect(discoverProjectSkillPaths(cwd)).toEqual([local, shared, claude, codex]);
  });

  test("keeps one mirrored name and all uniquely named skills", () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, ".git"));
    const claudeShared = writeSkill(join(root, ".claude", "skills"), "shared", "shared-skill");
    writeSkill(join(root, ".codex", "skills"), "shared", "shared-skill");
    const codexOnly = writeSkill(join(root, ".codex", "skills"), "codex-only", "codex-only");

    const paths = discoverProjectSkillPaths(root);
    const loaded = loadSkills({
      cwd: root,
      agentDir: getAgentDir(),
      skillPaths: [...paths],
      includeDefaults: false,
    });

    expect(paths).toEqual([claudeShared, codexOnly]);
    expect(loaded.skills.map((skill) => skill.filePath)).toEqual([claudeShared, codexOnly]);
    expect(loaded.diagnostics.filter((diagnostic) => diagnostic.type === "collision")).toEqual([]);
  });

  test("keeps one diagnostic path for mirrored malformed skills", () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, ".git"));
    const claudePath = join(root, ".claude", "skills", "broken", "SKILL.md");
    const codexPath = join(root, ".codex", "skills", "broken", "SKILL.md");
    for (const path of [claudePath, codexPath]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "---\nname: [\n---\n");
    }

    expect(discoverProjectSkillPaths(root)).toEqual([claudePath]);
  });

  test("does not search ancestors when cwd is outside a Git worktree", () => {
    const parent = temporaryDirectory();
    const cwd = join(parent, "project");
    writeSkill(join(parent, ".claude", "skills"), "parent", "parent");
    const local = writeSkill(join(cwd, ".codex", "skills"), "local", "local");

    expect(discoverProjectSkillPaths(cwd)).toEqual([local]);
  });
});
