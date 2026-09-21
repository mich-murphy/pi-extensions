import {
  type BuildSystemPromptOptions,
  formatSkillsForPrompt,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { hideResources } from "../prompt-filter";

const skillFileSuffix = /\/SKILL\.md$/;

function hiding(...paths: string[]): (path: string) => boolean {
  return (path) => paths.includes(path);
}

function renderProjectContext(
  contextFiles: ReadonlyArray<{ path: string; content: string }>,
): string {
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
    sourceInfo: { path: filePath, source: "local", scope: "project", origin: "top-level" },
    disableModelInvocation: false,
  };
}

const first = skill("deploy", "/work/client-a/.agents/skills/deploy/SKILL.md");
const second = skill("deploy", "/work/client-b/.agents/skills/deploy/SKILL.md");
const contextFiles = [
  { path: "/work/client-a/AGENTS.md", content: "client a" },
  { path: "/work/client-b/AGENTS.md", content: "client b" },
];

describe("hideResources on Pi 0.86 and newer", () => {
  test("filters the mutable options and returns no replacement prompt", () => {
    const options = {
      cwd: "/work",
      sections: {},
      contextFiles: [...contextFiles],
      skills: [first, second],
    };

    const result = hideResources(
      { systemPrompt: "rendered by Pi", systemPromptOptions: options },
      hiding(first.filePath, "/work/client-a/AGENTS.md"),
    );

    expect(result).toEqual({ _tag: "options-filtered" });
    expect(options.contextFiles).toEqual([contextFiles[1]]);
    expect(options.skills).toEqual([second]);
  });
});

describe("hideResources on Pi 0.85 and older", () => {
  test("removes resources by path without affecting same-named resources or the options", () => {
    const options: BuildSystemPromptOptions = {
      cwd: "/work",
      selectedTools: ["read"],
      contextFiles: [...contextFiles],
      skills: [first, second],
    };
    const systemPrompt = `base${renderProjectContext(contextFiles)}${formatSkillsForPrompt([first, second])}\ncwd`;

    const result = hideResources(
      { systemPrompt, systemPromptOptions: options },
      hiding(first.filePath, "/work/client-a/AGENTS.md"),
    );

    expect(result).toEqual({
      _tag: "prompt-filtered",
      systemPrompt: `base${renderProjectContext(contextFiles.slice(1))}${formatSkillsForPrompt([second])}\ncwd`,
      unmatched: [],
    });
    expect(options.contextFiles).toEqual(contextFiles);
    expect(options.skills).toEqual([first, second]);
  });

  test("removes a whole section when every resource in it is hidden", () => {
    const options: BuildSystemPromptOptions = {
      cwd: "/work",
      selectedTools: ["bash"],
      contextFiles: contextFiles.slice(0, 1),
      skills: [first],
    };
    const systemPrompt = `base${renderProjectContext(contextFiles.slice(0, 1))}${formatSkillsForPrompt([first])}\ncwd`;

    const result = hideResources(
      { systemPrompt, systemPromptOptions: options },
      hiding(first.filePath, "/work/client-a/AGENTS.md"),
    );

    expect(result).toEqual({ _tag: "prompt-filtered", systemPrompt: "base\ncwd", unmatched: [] });
  });

  test("reports only the sections that needed a replacement and could not be matched", () => {
    const options: BuildSystemPromptOptions = {
      cwd: "/work",
      contextFiles: [...contextFiles],
      skills: [first],
    };

    expect(
      hideResources(
        { systemPrompt: "rewritten prompt", systemPromptOptions: options },
        hiding(first.filePath, "/work/client-a/AGENTS.md"),
      ),
    ).toEqual({
      _tag: "prompt-filtered",
      systemPrompt: "rewritten prompt",
      unmatched: ["instructions", "skills"],
    });
    expect(
      hideResources(
        { systemPrompt: "rewritten prompt", systemPromptOptions: options },
        hiding("/work/client-a/AGENTS.md"),
      ),
    ).toMatchObject({ unmatched: ["instructions"] });
  });

  test("does not expect a skill section when no file-reading tool is active", () => {
    const options: BuildSystemPromptOptions = {
      cwd: "/work",
      selectedTools: ["edit"],
      skills: [first],
    };

    expect(
      hideResources({ systemPrompt: "base", systemPromptOptions: options }, hiding(first.filePath)),
    ).toEqual({ _tag: "prompt-filtered", systemPrompt: "base", unmatched: [] });
  });
});
