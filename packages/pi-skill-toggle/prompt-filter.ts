import {
  type BeforeAgentStartEvent,
  type BuildSystemPromptOptions,
  formatSkillsForPrompt,
} from "@earendil-works/pi-coding-agent";

/** Rendered prompt section that holds toggleable resources. */
export type PromptSection = "instructions" | "skills";

/** How hidden resources were kept from the model. */
export type PromptFilterResult =
  /** Pi 0.86+ renders the prompt from the filtered options. Nothing is returned to Pi. */
  | { readonly _tag: "options-filtered" }
  /** Pi 0.85 and older need replacement text. Unmatched sections still show hidden resources. */
  | {
      readonly _tag: "prompt-filtered";
      readonly systemPrompt: string;
      readonly unmatched: ReadonlyArray<PromptSection>;
    };

/**
 * Hide instruction files and skills from the prompt Pi is about to send.
 *
 * @param event - Pi's `before_agent_start` event.
 * @param isHidden - Whether the resource at a Pi-reported path must be hidden.
 * @returns The strategy that applied, with replacement text when Pi needs it.
 */
export function hideResources(
  event: Pick<BeforeAgentStartEvent, "systemPrompt" | "systemPromptOptions">,
  isHidden: (path: string) => boolean,
): PromptFilterResult {
  const options = event.systemPromptOptions;
  const contextFiles = options.contextFiles ?? [];
  const skills = options.skills ?? [];
  const shownContextFiles = contextFiles.filter((file) => !isHidden(file.path));
  const shownSkills = skills.filter((skill) => !isHidden(skill.filePath));

  // Pi 0.86 introduced `sections` together with a per-run copy of the options that extensions
  // may mutate. Older releases share their live options object, which must stay untouched.
  if ("sections" in options) {
    options.contextFiles = shownContextFiles;
    options.skills = shownSkills;
    return { _tag: "options-filtered" };
  }

  const tools = options.selectedTools ?? ["read"];
  const replacements: ReadonlyArray<readonly [PromptSection, string, string]> = [
    ["instructions", renderContext(contextFiles), renderContext(shownContextFiles)],
    ["skills", renderSkills(skills, tools), renderSkills(shownSkills, tools)],
  ];
  let systemPrompt = event.systemPrompt;
  const unmatched: PromptSection[] = [];
  for (const [section, original, replacement] of replacements) {
    if (original === replacement) continue;
    const index = systemPrompt.lastIndexOf(original);
    if (index < 0) {
      unmatched.push(section);
      continue;
    }
    systemPrompt = `${systemPrompt.slice(0, index)}${replacement}${systemPrompt.slice(index + original.length)}`;
  }
  return { _tag: "prompt-filtered", systemPrompt, unmatched };
}

type ContextFiles = NonNullable<BuildSystemPromptOptions["contextFiles"]>;
type PromptSkills = NonNullable<BuildSystemPromptOptions["skills"]>;

/** Mirror of the project context section rendered by Pi 0.85 and older. */
function renderContext(contextFiles: ContextFiles): string {
  if (contextFiles.length === 0) return "";
  const blocks = contextFiles.map(
    ({ path, content }) =>
      `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`,
  );
  return `\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n${blocks.join("")}</project_context>\n`;
}

/** Pi advertises skills only when a tool that can read their files is active. */
function renderSkills(skills: PromptSkills, tools: ReadonlyArray<string>): string {
  const reader = (["read", "bash"] as const).find((tool) => tools.includes(tool));
  if (!reader) return "";
  // SAFETY: Pi 0.85 added the reader argument. JavaScript ignores it on older releases.
  const format = formatSkillsForPrompt as (skills: PromptSkills, reader: "read" | "bash") => string;
  return format(skills, reader);
}
