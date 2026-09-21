import {
  type BuildSystemPromptOptions,
  formatSkillsForPrompt,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { applyResourceToggles } from "../prompt-filter";
import { resourcePathId } from "../resource-path";

const skillFileSuffix = /\/SKILL\.md$/;

function resourcePaths(...paths: string[]) {
  return new Set(paths.map((path) => resourcePathId(path)));
}

function renderProjectContext(
  contextFiles: ReadonlyArray<{ path: string; content: string }>,
): string {
  if (contextFiles.length === 0) return "";
  const instructions = contextFiles
    .map(
      ({ path, content }) =>
        `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`,
    )
    .join("");
  return `\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n${instructions}</project_context>\n`;
}

function skill(name: string, filePath: string): Skill {
  return {
    name,
    description: `${name} at ${filePath}`,
    filePath,
    baseDir: filePath.replace(skillFileSuffix, ""),
    sourceInfo: {
      path: filePath,
      source: "local",
      scope: "project",
      origin: "top-level",
    },
    disableModelInvocation: false,
  };
}

describe("applyResourceToggles", () => {
  test("removes resources by path without affecting same-named resources", () => {
    const first = skill("deploy", "/work/client-a/.agents/skills/deploy/SKILL.md");
    const second = skill("deploy", "/work/client-b/.agents/skills/deploy/SKILL.md");
    const firstContextPath = "/work/client-a/AGENTS.md";
    const contextFiles = [
      { path: firstContextPath, content: "client a" },
      { path: "/work/client-b/AGENTS.md", content: "client b" },
    ];
    const options: BuildSystemPromptOptions = {
      cwd: "/work",
      selectedTools: ["read"],
      contextFiles,
      skills: [first, second],
    };
    const prompt = `base${renderProjectContext(contextFiles)}${formatSkillsForPrompt([first, second])}`;

    const result = applyResourceToggles(
      prompt,
      options,
      resourcePaths(first.filePath, firstContextPath),
    );

    expect(result.failures).toEqual([]);
    expect(result.systemPrompt).not.toContain("client a");
    expect(result.systemPrompt).toContain("client b");
    expect(result.systemPrompt).not.toContain(first.description);
    expect(result.systemPrompt).toContain(second.description);
  });

  test("filters Pi's structured prompt sections", () => {
    const first = skill("deploy", "/work/client-a/.agents/skills/deploy/SKILL.md");
    const second = skill("review", "/work/client-b/.agents/skills/review/SKILL.md");
    const firstContextPath = "/work/client-a/AGENTS.md";
    const contextFiles = [
      { path: firstContextPath, content: "client a" },
      { path: "/work/client-b/AGENTS.md", content: "client b" },
    ];
    const options: BuildSystemPromptOptions = {
      cwd: "/work",
      selectedTools: ["read"],
      contextFiles,
      skills: [first, second],
    };
    const contextContent = [
      "Project-specific instructions and guidelines:",
      ...contextFiles.map(
        ({ path, content }) =>
          `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
      ),
    ].join("\n\n");
    const prompt = [
      "base",
      `<project_context>\n${contextContent}\n</project_context>`,
      `<skills>\n${formatSkillsForPrompt([first, second]).trim()}\n</skills>`,
    ].join("\n\n");

    const result = applyResourceToggles(
      prompt,
      options,
      resourcePaths(first.filePath, firstContextPath),
    );

    expect(result.failures).toEqual([]);
    expect(result.systemPrompt).not.toContain("client a");
    expect(result.systemPrompt).toContain("client b");
    expect(result.systemPrompt).not.toContain(first.description);
    expect(result.systemPrompt).toContain(second.description);
    expect(result.systemPrompt).toContain("<project_context>");
    expect(result.systemPrompt).toContain("<skills>");
  });

  test("filters skills rendered for bash-only sessions", () => {
    const deploy = skill("deploy", "/work/project/.agents/skills/deploy/SKILL.md");
    const options: BuildSystemPromptOptions = {
      cwd: "/work/project",
      selectedTools: ["bash"],
      skills: [deploy],
    };
    const bashSkills = formatSkillsForPrompt([deploy]).replace(
      "Use the read tool to load a skill's file when the task matches its description.",
      "Use bash to load a skill's file when the task matches its description.",
    );
    const prompt = `base\n\n<skills>\n${bashSkills.trim()}\n</skills>`;

    const result = applyResourceToggles(prompt, options, resourcePaths(deploy.filePath));

    expect(result).toEqual({ systemPrompt: "base\n\n", failures: [] });
  });

  test("reports section-specific prompt drift only when a replacement is required", () => {
    const deploy = skill("deploy", "/work/project/.agents/skills/deploy/SKILL.md");
    const options: BuildSystemPromptOptions = {
      cwd: "/work/project",
      contextFiles: [{ path: "/work/project/AGENTS.md", content: "rules" }],
      skills: [deploy],
    };

    const result = applyResourceToggles(
      "incompatible prompt",
      options,
      resourcePaths("/work/project/AGENTS.md", deploy.filePath),
    );

    expect(result).toEqual({
      systemPrompt: "incompatible prompt",
      failures: ["instructions", "skills"],
    });
  });

  test("does not expect a skill section when no file-reading tool is active", () => {
    const deploy = skill("deploy", "/work/project/.agents/skills/deploy/SKILL.md");
    const options: BuildSystemPromptOptions = {
      cwd: "/work/project",
      selectedTools: ["edit"],
      skills: [deploy],
    };

    expect(applyResourceToggles("base", options, resourcePaths(deploy.filePath))).toEqual({
      systemPrompt: "base",
      failures: [],
    });
  });
});
