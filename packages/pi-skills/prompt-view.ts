import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { resourcePathId } from "./resource-path";
import type { ResourcePath } from "./resource-path";
import type { ToggleResource } from "./resources";

export type PromptResource = {
  readonly id: ResourcePath;
  readonly kind: ToggleResource["kind"];
  readonly path: string;
  readonly name: string;
  readonly body: string;
};

export type SkillReader = "read" | "bash" | "indirect";

const READERS = ["read", "bash"] as const;
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

export function skillReader(
  options: Pick<BuildSystemPromptOptions, "selectedTools" | "hiddenTools">,
): SkillReader {
  const selected = options.selectedTools ?? DEFAULT_TOOLS;
  const hidden = new Set(options.hiddenTools);
  const declared = new Set(selected.filter((name) => !hidden.has(name)));

  return READERS.find((tool) => declared.has(tool)) ?? "indirect";
}

export const RESOURCE_SECTIONS = {
  instruction: "project_context",
  skill: "skills",
} as const satisfies Record<ToggleResource["kind"], string>;

export function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function promptResources(
  options: BuildSystemPromptOptions,
  resources: readonly Pick<ToggleResource, "id" | "editability">[],
): readonly PromptResource[] {
  const editable = new Set(
    resources.flatMap(({ editability, id }) => (editability === "editable" ? [id] : [])),
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

function sectionRenders(content: string, resource: Pick<PromptResource, "kind" | "path">): boolean {
  return content.includes(
    resource.kind === "skill"
      ? `<location>${escapeXml(resource.path)}</location>`
      : `<project_instructions path="${resource.path}">`,
  );
}

export function isInPrompt(
  sections: Readonly<Record<string, string | null>>,
  resource: Pick<PromptResource, "kind" | "path">,
): boolean {
  return sectionRenders(sections[RESOURCE_SECTIONS[resource.kind]] ?? "", resource);
}
