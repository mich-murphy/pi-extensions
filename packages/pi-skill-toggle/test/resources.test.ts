import { homedir } from "node:os";
import { join } from "node:path";
import {
  type BuildSystemPromptOptions,
  getAgentDir,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { type ResourcePath, resourcePathId } from "../resource-path";
import { defaultToggleValue, toggleResources, toggleValue } from "../resources";

function skill(
  name: string,
  filePath: string,
  sourceInfo: Skill["sourceInfo"],
  disableModelInvocation = false,
): Skill {
  return {
    name,
    description: `${name} description`,
    filePath,
    baseDir: join(filePath, ".."),
    sourceInfo,
    disableModelInvocation,
  };
}

const noContributedSkills: ReadonlySet<ResourcePath> = new Set();

function toggleResourcesFromPrompt(options: BuildSystemPromptOptions) {
  return toggleResources(options, noContributedSkills);
}

describe("toggleResources", () => {
  test("groups global resources before project resources and sorts skills by name", () => {
    const options: BuildSystemPromptOptions = {
      cwd: "/work/project/src",
      contextFiles: [
        { path: join(getAgentDir(), "AGENTS.md"), content: "global" },
        { path: "/work/AGENTS.md", content: "parent" },
        { path: "/work/project/CLAUDE.md", content: "project" },
      ],
      skills: [
        skill("zeta", join(homedir(), ".agents/skills/zeta/SKILL.md"), {
          path: join(homedir(), ".agents/skills/zeta/SKILL.md"),
          source: "local",
          scope: "user",
          origin: "top-level",
        }),
        skill("alpha", join(getAgentDir(), "skills/alpha/SKILL.md"), {
          path: join(getAgentDir(), "skills/alpha/SKILL.md"),
          source: "local",
          scope: "user",
          origin: "top-level",
        }),
        skill("deploy", "/work/project/.agents/skills/deploy/SKILL.md", {
          path: "/work/project/.agents/skills/deploy/SKILL.md",
          source: "local",
          scope: "project",
          origin: "top-level",
        }),
      ],
    };

    expect(
      toggleResourcesFromPrompt(options).map(
        ({ origin, kind, label }) => `${origin}:${kind}:${label}`,
      ),
    ).toEqual([
      "global:instruction:AGENTS.md",
      "global:skill:alpha",
      "global:skill:zeta",
      "project:instruction:AGENTS.md",
      "project:instruction:CLAUDE.md",
      "project:skill:deploy",
    ]);
  });

  test("includes project-scoped skills loaded from a configured non-Pi directory", () => {
    const cwd = "/Users/mm/businesscraft/businesscraft";
    const path = join(cwd, ".claude/skills/businesscraft-design/SKILL.md");
    const resources = toggleResourcesFromPrompt({
      cwd,
      skills: [
        skill("businesscraft-design", path, {
          path,
          source: "local",
          scope: "project",
          origin: "top-level",
        }),
      ],
    });

    expect(resources).toMatchObject([
      {
        id: path,
        origin: "project",
        kind: "skill",
        label: "businesscraft-design",
      },
    ]);
  });

  test("treats temporary skills as project skills only when this extension contributed them", () => {
    const cwd = "/Users/mm/businesscraft/businesscraft/web";
    const contributedPath = "/Users/mm/businesscraft/businesscraft/.claude/skills/design/SKILL.md";
    const cliPath = "/Users/mm/businesscraft/businesscraft/.claude/skills/review/SKILL.md";
    const temporary = (name: string, path: string): Skill =>
      skill(name, path, { path, source: "cli", scope: "temporary", origin: "top-level" });

    const resources = toggleResources(
      { cwd, skills: [temporary("design", contributedPath), temporary("review", cliPath)] },
      new Set([resourcePathId(contributedPath, cwd)]),
    );

    expect(resources).toMatchObject([{ id: contributedPath, origin: "project", kind: "skill" }]);
  });

  test("deduplicates repeated discovery paths", () => {
    const path = join(getAgentDir(), "AGENTS.md");
    const resources = toggleResourcesFromPrompt({
      cwd: "/work/project",
      contextFiles: [
        { path, content: "first" },
        { path, content: "duplicate" },
      ],
    });

    expect(resources).toHaveLength(1);
    expect(resources[0]?.id).toBe(resourcePathId(path, "/work/project"));
  });

  test("preserves the discovery path when a global instruction is symlinked elsewhere", () => {
    const path = join(getAgentDir(), "AGENTS.md");
    const resources = toggleResourcesFromPrompt({
      cwd: "/work/project",
      contextFiles: [{ path, content: "rules" }],
    });

    expect(resources[0]).toMatchObject({ id: path, origin: "global", label: "AGENTS.md" });
  });

  test("excludes packages, temporary skills, and skills outside standard roots", () => {
    const options: BuildSystemPromptOptions = {
      cwd: "/work/project",
      skills: [
        skill("package-skill", "/packages/skill/SKILL.md", {
          path: "/packages/skill/SKILL.md",
          source: "npm:test",
          scope: "user",
          origin: "package",
        }),
        skill("temporary", "/tmp/skill/SKILL.md", {
          path: "/tmp/skill/SKILL.md",
          source: "cli",
          scope: "temporary",
          origin: "top-level",
        }),
        skill("extension-skill", join(getAgentDir(), "extensions/example/skill/SKILL.md"), {
          path: join(getAgentDir(), "extensions/example/index.ts"),
          source: "local",
          scope: "user",
          origin: "top-level",
        }),
      ],
    };

    expect(toggleResourcesFromPrompt(options)).toEqual([]);
  });

  test("marks source-authored manual-only skills as read-only", () => {
    const path = join(getAgentDir(), "skills/manual/SKILL.md");
    const resources = toggleResourcesFromPrompt({
      cwd: "/work/project",
      skills: [
        skill(
          "manual",
          path,
          {
            path,
            source: "local",
            scope: "user",
            origin: "top-level",
          },
          true,
        ),
      ],
    });

    expect(resources[0]?.editability).toBe("manual-only");
  });

  test("hides project skills by default and lets an override win either way", () => {
    const projectSkill = { kind: "skill", origin: "project" } as const;
    const path = join(getAgentDir(), "AGENTS.md");
    const [instruction] = toggleResourcesFromPrompt({
      cwd: "/work/project",
      contextFiles: [{ path, content: "rules" }],
    });
    if (!instruction) throw new Error("expected the global instruction");

    expect(defaultToggleValue(projectSkill)).toBe("disabled");
    expect(defaultToggleValue({ kind: "skill", origin: "global" })).toBe("enabled");
    expect(defaultToggleValue({ kind: "instruction", origin: "project" })).toBe("enabled");
    expect(toggleValue(new Map(), instruction)).toBe("enabled");
    expect(toggleValue(new Map([[instruction.id, "disabled"]]), instruction)).toBe("disabled");
  });
});
