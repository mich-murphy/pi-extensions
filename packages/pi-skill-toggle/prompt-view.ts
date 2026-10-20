import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { resourcePathId } from "./resource-path";
import type { ResourcePath } from "./resource-path";
import type { ToggleResource } from "./resources";

/** An editable toggle resource as Pi renders it into the prompt. */
export type PromptResource = {
  readonly id: ResourcePath;
  readonly kind: ToggleResource["kind"];
  /** Path exactly as Pi renders it: a skill's file path or an instruction's path. */
  readonly path: string;
  /** Skill name, or the instruction path. */
  readonly name: string;
  /** Skill description, or the instruction content. */
  readonly body: string;
};

/** The tool Pi's skill guidance names, as `formatSkillsForPrompt` takes it. */
export type SkillReader = "read" | "bash" | "indirect";

const READERS = ["read", "bash"] as const;
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

/**
 * Choose the skill reader exactly like Pi's `buildSystemPromptSections`: the first declared
 * reader, else `indirect` when a reader is selected but hidden.
 *
 * Without any reader Pi lists no skills; notes then name no tool either.
 */
export function skillReader(
  options: Pick<BuildSystemPromptOptions, "selectedTools" | "hiddenTools">,
): SkillReader {
  const selected = options.selectedTools ?? DEFAULT_TOOLS;
  const hidden = new Set(options.hiddenTools);
  const declared = new Set(selected.filter((name) => !hidden.has(name)));
  return READERS.find((tool) => declared.has(tool)) ?? "indirect";
}

/** Prompt sections that hold toggle resources, by resource kind. */
export const RESOURCE_SECTIONS = {
  instruction: "project_context",
  skill: "skills",
} as const satisfies Record<ToggleResource["kind"], string>;

/** Escape text exactly like Pi's `formatSkillsForPrompt`. */
export function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Pair every editable toggle resource with the prompt options entry Pi renders for it.
 *
 * Manual-only skills are left out: Pi never renders them, so they are not part of the prompt view.
 */
export function promptResources(
  options: BuildSystemPromptOptions,
  resources: readonly Pick<ToggleResource, "id" | "editability">[],
): readonly PromptResource[] {
  const editable = new Set(
    resources.filter((resource) => resource.editability === "editable").map(({ id }) => id),
  );
  const entries: readonly PromptResource[] = [
    ...(options.contextFiles ?? []).map<PromptResource>((file) => ({
      id: resourcePathId(file.path, options.cwd),
      kind: "instruction",
      path: file.path,
      name: file.path,
      body: file.content,
    })),
    ...(options.skills ?? []).map<PromptResource>((skill) => ({
      id: resourcePathId(skill.filePath, options.cwd),
      kind: "skill",
      path: skill.filePath,
      name: skill.name,
      body: skill.description,
    })),
  ];
  const unique = new Map<ResourcePath, PromptResource>();
  for (const entry of entries) {
    if (editable.has(entry.id) && !unique.has(entry.id)) {
      unique.set(entry.id, entry);
    }
  }
  return [...unique.values()];
}

/** Whether a rendered section's text advertises a resource, matching Pi's exact markup. */
function sectionRenders(content: string, resource: Pick<PromptResource, "kind" | "path">): boolean {
  return content.includes(
    resource.kind === "skill"
      ? `<location>${escapeXml(resource.path)}</location>`
      : `<project_instructions path="${resource.path}">`,
  );
}

/** Whether the current prompt sections advertise a resource. */
export function isInPrompt(
  sections: Readonly<Record<string, string | null>>,
  resource: Pick<PromptResource, "kind" | "path">,
): boolean {
  return sectionRenders(sections[RESOURCE_SECTIONS[resource.kind]] ?? "", resource);
}
