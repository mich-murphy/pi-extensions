import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import type { BuildSystemPromptOptions, Skill, SourceInfo } from "@earendil-works/pi-coding-agent";
import { Data } from "effect";

export type PromptSection = "instructions" | "skills";

export type PromptFilterResult =
  | { readonly _tag: "options-filtered" }
  | {
      readonly _tag: "prompt-filtered";
      readonly systemPrompt: string;
      readonly unmatched: readonly PromptSection[];
    };

export const PromptFilterResult = Data.taggedEnum<PromptFilterResult>();

export type PromptFilterEvent = {
  readonly systemPrompt: string;
  readonly systemPromptOptions: BuildSystemPromptOptions;
};

export function hideResources(
  event: PromptFilterEvent,
  isHidden: (path: string) => boolean,
): PromptFilterResult {
  const options = event.systemPromptOptions;
  const contextFiles = options.contextFiles ?? [];
  const skills = options.skills ?? [];
  const shownContextFiles = contextFiles.filter((file) => !isHidden(file.path));
  const shownSkills = skills.filter((skill) => !isHidden(skill.filePath));

  if ("sections" in options) {
    options.contextFiles = shownContextFiles;
    options.skills = shownSkills;

    return PromptFilterResult["options-filtered"]();
  }

  const tools = options.selectedTools ?? ["read"];

  const replacements: readonly (readonly [PromptSection, string, string])[] = [
    ["instructions", renderContext(contextFiles), renderContext(shownContextFiles)],
    ["skills", renderSkills(skills, tools), renderSkills(shownSkills, tools)],
  ];

  let { systemPrompt } = event;
  const unmatched: PromptSection[] = [];

  for (const [section, original, replacement] of replacements) {
    if (original === replacement) {
      continue;
    }

    const index = systemPrompt.lastIndexOf(original);

    if (index === -1) {
      unmatched.push(section);
      continue;
    }

    systemPrompt = `${systemPrompt.slice(0, index)}${replacement}${systemPrompt.slice(index + original.length)}`;
  }

  return PromptFilterResult["prompt-filtered"]({ systemPrompt, unmatched });
}

type ContextFile = Readonly<NonNullable<BuildSystemPromptOptions["contextFiles"]>[number]>;

type PromptSkill = Readonly<Omit<Skill, "sourceInfo">> & {
  readonly sourceInfo: Readonly<SourceInfo>;
};

function renderContext(contextFiles: readonly ContextFile[]): string {
  if (contextFiles.length === 0) {
    return "";
  }

  const blocks = contextFiles.map(
    ({ path, content }) =>
      `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`,
  );

  return `\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n${blocks.join("")}</project_context>\n`;
}

function renderSkills(skills: readonly PromptSkill[], tools: readonly string[]): string {
  const reader = (["read", "bash"] as const).find((tool) => tools.includes(tool));

  if (!reader) {
    return "";
  }

  return formatSkillsForPrompt([...skills], reader);
}
