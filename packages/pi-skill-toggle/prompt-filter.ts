import {
  type BuildSystemPromptOptions,
  formatSkillsForPrompt,
} from "@earendil-works/pi-coding-agent";
import { type ResourcePath, resourcePathId } from "./resource-path";

/** Prompt filtering result and any sections that could not be matched safely. */
export interface PromptToggleResult {
  readonly systemPrompt: string;
  readonly failures: ReadonlyArray<"instructions" | "skills">;
}

/** Remove disabled instruction files and skills from Pi's model-facing prompt. */
export function applyResourceToggles(
  systemPrompt: string,
  options: BuildSystemPromptOptions,
  disabledResourcePaths: ReadonlySet<ResourcePath>,
): PromptToggleResult {
  const failures: Array<"instructions" | "skills"> = [];
  const contextFiles = options.contextFiles ?? [];
  const enabledContextFiles = contextFiles.filter(
    (file) => !disabledResourcePaths.has(resourcePathId(file.path, options.cwd)),
  );
  const originalContext = renderProjectContext(contextFiles);
  const enabledContext = renderProjectContext(enabledContextFiles);
  const contextResult =
    enabledContextFiles.length === contextFiles.length
      ? { value: systemPrompt, matched: true }
      : replaceSectionFormats(systemPrompt, originalContext, enabledContext);
  if (!contextResult.matched) failures.push("instructions");

  const skillFileReadTool = options.selectedTools
    ? (["read", "bash"] as const).find((tool) => options.selectedTools?.includes(tool))
    : "read";
  if (!skillFileReadTool) return { systemPrompt: contextResult.value, failures };

  const skills = options.skills ?? [];
  const enabledSkills = skills.filter(
    (skill) => !disabledResourcePaths.has(resourcePathId(skill.filePath, options.cwd)),
  );
  const originalSkills = renderSkills(skills, skillFileReadTool);
  const enabledSkillsPrompt = renderSkills(enabledSkills, skillFileReadTool);
  const skillResult =
    enabledSkills.length === skills.length
      ? { value: contextResult.value, matched: true }
      : replacePromptSection(contextResult.value, "skills", originalSkills, enabledSkillsPrompt);
  if (!skillResult.matched) failures.push("skills");
  return { systemPrompt: skillResult.value, failures };
}

type ContextFile = NonNullable<BuildSystemPromptOptions["contextFiles"]>[number];

interface PromptSectionFormats {
  readonly legacy: string;
  readonly structured: string;
}

function renderProjectContext(contextFiles: readonly ContextFile[]): PromptSectionFormats {
  if (contextFiles.length === 0) return { legacy: "", structured: "" };
  const instructionBlocks = contextFiles.map(
    ({ path, content }) =>
      `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
  );
  const content = ["Project-specific instructions and guidelines:", ...instructionBlocks].join(
    "\n\n",
  );
  return {
    legacy: `\n\n<project_context>\n\n${content}\n\n</project_context>\n`,
    structured: `<project_context>\n${content}\n</project_context>`,
  };
}

type SkillPromptFormatter = (
  skills: NonNullable<BuildSystemPromptOptions["skills"]>,
  fileReadTool?: "read" | "bash",
) => string;

function renderSkills(
  skills: NonNullable<BuildSystemPromptOptions["skills"]>,
  fileReadTool: "read" | "bash",
): string {
  // SAFETY: Pi 0.85 added the optional reader argument. Older releases ignore extra JavaScript arguments.
  const formatSkills = formatSkillsForPrompt as SkillPromptFormatter;
  const prompt = formatSkills(skills, fileReadTool);
  return fileReadTool === "read"
    ? prompt
    : prompt.replace(
        "Use the read tool to load a skill's file when the task matches its description.",
        "Use bash to load a skill's file when the task matches its description.",
      );
}

function replaceSectionFormats(
  input: string,
  original: PromptSectionFormats,
  replacement: PromptSectionFormats,
): { value: string; matched: boolean } {
  const legacyResult = replaceLastExact(input, original.legacy, replacement.legacy);
  return legacyResult.matched
    ? legacyResult
    : replaceLastExact(input, original.structured, replacement.structured);
}

function replacePromptSection(
  input: string,
  sectionName: string,
  originalContent: string,
  replacementContent: string,
): { value: string; matched: boolean } {
  const legacyResult = replaceLastExact(input, originalContent, replacementContent);
  if (legacyResult.matched) return legacyResult;

  const originalSection = `<${sectionName}>\n${originalContent.trim()}\n</${sectionName}>`;
  const replacementSection = replacementContent
    ? `<${sectionName}>\n${replacementContent.trim()}\n</${sectionName}>`
    : "";
  return replaceLastExact(input, originalSection, replacementSection);
}

function replaceLastExact(
  input: string,
  original: string,
  replacement: string,
): { value: string; matched: boolean } {
  if (original.length === 0) return { value: input, matched: false };
  const index = input.lastIndexOf(original);
  if (index < 0) return { value: input, matched: false };
  return {
    value: `${input.slice(0, index)}${replacement}${input.slice(index + original.length)}`,
    matched: true,
  };
}
