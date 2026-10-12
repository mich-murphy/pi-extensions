import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DefaultResourceLoader,
  loadSkills,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { registerSkillToggle } from "../index";
import type { ToggleHandlers } from "../index";
import { discoverProjectSkillPaths } from "../project-skill-paths";
import { ok } from "../result";
import type { ToggleStateStore } from "../state";

const temporaryDirectories: string[] = [];

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

function project(): { readonly root: string; readonly cwd: string; readonly agentDir: string } {
  const root = temporaryDirectory();
  const cwd = join(root, "apps", "web");
  const agentDir = join(root, "agent");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  return { root, cwd, agentDir };
}

async function pathsFor(cwd: string, agentDir: string): Promise<readonly string[]> {
  return discoverProjectSkillPaths(cwd, agentDir);
}

function requiredDiscover(handlers: Partial<ToggleHandlers>): ToggleHandlers["resources_discover"] {
  const discover = handlers.resources_discover;
  if (!discover) {
    throw new Error("test setup: resources_discover was not registered");
  }
  return discover;
}

describe("discoverProjectSkillPaths", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("supplements native discovery from cwd through the Git root", async () => {
    const { root, cwd, agentDir } = project();
    writeSkill(join(cwd, ".pi", "skills"), "local", "local");
    writeSkill(join(root, ".agents", "skills"), "shared", "shared");
    const ancestorPi = writeSkill(join(root, ".pi", "skills"), "ancestor", "ancestor");
    const claude = writeSkill(join(root, ".claude", "skills"), "claude", "claude");
    const codex = writeSkill(join(root, ".codex", "skills"), "codex", "codex");

    await expect(pathsFor(cwd, agentDir)).resolves.toStrictEqual([ancestorPi, claude, codex]);
  });

  test("keeps one mirrored supplemental name and every unique skill", async () => {
    const { root, agentDir } = project();
    const claudeShared = writeSkill(join(root, ".claude", "skills"), "shared", "shared-skill");
    writeSkill(join(root, ".codex", "skills"), "shared", "shared-skill");
    const codexOnly = writeSkill(join(root, ".codex", "skills"), "codex-only", "codex-only");

    const paths = await pathsFor(root, agentDir);
    const loaded = loadSkills({
      cwd: root,
      agentDir,
      skillPaths: [...paths],
      includeDefaults: false,
    });

    expect(paths).toStrictEqual([claudeShared, codexOnly]);
    expect(loaded.skills.map((skill) => skill.filePath)).toStrictEqual([claudeShared, codexOnly]);
    expect(
      loaded.diagnostics.filter((diagnostic) => diagnostic.type === "collision"),
    ).toStrictEqual([]);
  });

  test("does not report a malformed mirror when another harness has a valid copy", async () => {
    const { root, agentDir } = project();
    const claudePath = join(root, ".claude", "skills", "shared", "SKILL.md");
    mkdirSync(dirname(claudePath), { recursive: true });
    writeFileSync(claudePath, "---\nname: [\n---\n");
    const codexPath = writeSkill(join(root, ".codex", "skills"), "shared", "shared");

    const paths = await pathsFor(root, agentDir);
    const loaded = loadSkills({
      cwd: root,
      agentDir,
      skillPaths: [...paths],
      includeDefaults: false,
    });

    expect(paths).toStrictEqual([codexPath]);
    expect(loaded.skills.map((skill) => skill.filePath)).toStrictEqual([codexPath]);
    expect(loaded.diagnostics).toStrictEqual([]);
  });

  test("ignores invalid supplemental skill metadata", async () => {
    const { root, agentDir } = project();
    const path = join(root, ".claude", "skills", "invalid", "SKILL.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\nname: invalid\ndescription: ${"x".repeat(1025)}\n---\n`);

    await expect(pathsFor(root, agentDir)).resolves.toStrictEqual([]);
  });

  test("ignores malformed supplemental skills", async () => {
    const { root, agentDir } = project();
    for (const path of [
      join(root, ".claude", "skills", "broken", "SKILL.md"),
      join(root, ".codex", "skills", "broken", "SKILL.md"),
    ]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "---\nname: [\n---\n");
    }

    await expect(pathsFor(root, agentDir)).resolves.toStrictEqual([]);
  });

  test("does not search ancestors when cwd is outside a Git worktree", async () => {
    const parent = temporaryDirectory();
    const cwd = join(parent, "project");
    const agentDir = join(parent, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeSkill(join(parent, ".claude", "skills"), "parent", "parent");
    const local = writeSkill(join(cwd, ".codex", "skills"), "local", "local");

    await expect(pathsFor(cwd, agentDir)).resolves.toStrictEqual([local]);
  });

  test("reserves native global, configured, .pi, and .agents winners", async () => {
    const { root, cwd, agentDir } = project();
    writeSkill(join(agentDir, "skills"), "global", "global-winner");
    const configured = writeSkill(join(root, "configured"), "configured", "configured-winner");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: [configured] }));
    writeSkill(join(cwd, ".pi", "skills"), "pi", "pi-winner");
    writeSkill(join(root, ".agents", "skills"), "agents", "agents-winner");
    for (const name of ["global-winner", "configured-winner", "pi-winner", "agents-winner"]) {
      writeSkill(join(root, ".claude", "skills"), name, name);
    }
    const supplemental = writeSkill(
      join(root, ".claude", "skills"),
      "supplemental",
      "supplemental",
    );

    await expect(pathsFor(cwd, agentDir)).resolves.toStrictEqual([supplemental]);
  });

  test("the extension binding reserves a real loader's additional skill winner", async () => {
    const { root, cwd, agentDir } = project();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const explicit = writeSkill(join(root, "explicit"), "winner", "cli-collision");
    writeSkill(join(root, ".claude", "skills"), "duplicate", "cli-collision");
    const extra = writeSkill(join(root, ".claude", "skills"), "extra", "extra");
    const settingsManager = SettingsManager.inMemory(
      { enableSkillCommands: false },
      { projectTrusted: true },
    );
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalSkillPaths: [explicit],
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const handlers: Partial<ToggleHandlers> = {};
    const piDouble = {
      registerCommand: () => undefined,
      on: <K extends keyof ToggleHandlers>(name: K, handler: ToggleHandlers[K]) => {
        handlers[name] = handler;
      },
      // This is the public getCommands contract bound by AgentSession in Pi 0.85 and 1.1.
      getCommands: (): SlashCommandInfo[] =>
        loader.getSkills().skills.map((skill) => ({
          name: `skill:${skill.name}`,
          description: skill.description,
          source: "skill",
          sourceInfo: skill.sourceInfo,
        })),
    };
    const store: ToggleStateStore = {
      load: () => ok(new Map()),
      set: () => ok(new Map()),
    };
    registerSkillToggle(piDouble, store);
    const discover = requiredDiscover(handlers);

    const contribution = await discover({}, { cwd, isProjectTrusted: () => true });
    expect(contribution).toStrictEqual({ skillPaths: [extra] });
    loader.extendResources({
      skillPaths: [extra].map((path) => ({
        path,
        metadata: { source: "extension:test", scope: "temporary", origin: "top-level" },
      })),
    });
    await expect(discover({}, { cwd, isProjectTrusted: () => true })).resolves.toStrictEqual({
      skillPaths: [extra],
    });
    const loaded = loader.getSkills();

    expect(loaded.skills.find((skill) => skill.name === "cli-collision")?.filePath).toBe(explicit);
    expect(
      loaded.diagnostics.filter((diagnostic) => diagnostic.type === "collision"),
    ).toStrictEqual([]);
  });

  test("a real DefaultResourceLoader keeps excluded native skills out without collision warnings", async () => {
    const { root, cwd, agentDir } = project();
    const excluded = writeSkill(join(root, ".agents", "skills"), "excluded", "excluded-native");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ skills: [`-${excluded}`] }));
    writeSkill(join(cwd, ".pi", "skills"), "winner", "shared");
    writeSkill(join(root, ".claude", "skills"), "loser", "shared");
    writeSkill(join(root, ".claude", "skills"), "excluded-copy", "excluded-native");
    const extra = writeSkill(join(root, ".codex", "skills"), "extra", "extra");
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    const paths = await pathsFor(cwd, agentDir);
    loader.extendResources({
      skillPaths: paths.map((path) => ({
        path,
        metadata: { source: "extension:test", scope: "temporary", origin: "top-level" },
      })),
    });
    const loaded = loader.getSkills();

    expect(paths).toStrictEqual([extra]);
    expect(
      loaded.skills.filter((skill) => skill.filePath.startsWith(root)).map((skill) => skill.name),
    ).toStrictEqual(["shared", "extra"]);
    expect(loaded.skills.some((skill) => skill.filePath === excluded)).toBe(false);
    expect(
      loaded.diagnostics.filter((diagnostic) => diagnostic.type === "collision"),
    ).toStrictEqual([]);
  });
});
