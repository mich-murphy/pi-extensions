import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type BuildSystemPromptOptions, getAgentDir } from "@earendil-works/pi-coding-agent";
import { pathIsInsideOrEqual, type ResourcePath, resourcePathId } from "./resource-path";

/** Whether Pi advertises a resource to the model. */
export type ToggleValue = "enabled" | "disabled";

/** User choices that differ from a resource's default, keyed by resource path. */
export type ToggleOverrides = ReadonlyMap<ResourcePath, ToggleValue>;

/** A user-managed instruction file or skill that appears in the toggle menu. */
export interface ToggleResource {
  readonly id: ResourcePath;
  readonly kind: "instruction" | "skill";
  /** Menu group. Global resources are listed before project resources. */
  readonly origin: "global" | "project";
  readonly label: string;
  readonly description: string;
  /** Skills that declare `disable-model-invocation` are shown but never toggled. */
  readonly editability: "editable" | "manual-only";
}

/** Narrow an untrusted value to a toggle value. */
export function isToggleValue(value: unknown): value is ToggleValue {
  return value === "enabled" || value === "disabled";
}

/** Project skills stay hidden until the user enables them. Everything else starts visible. */
export function defaultToggleValue(resource: Pick<ToggleResource, "kind" | "origin">): ToggleValue {
  return resource.kind === "skill" && resource.origin === "project" ? "disabled" : "enabled";
}

/** Resolve a resource's override or its default. */
export function toggleValue(overrides: ToggleOverrides, resource: ToggleResource): ToggleValue {
  return overrides.get(resource.id) ?? defaultToggleValue(resource);
}

type PromptSkill = NonNullable<BuildSystemPromptOptions["skills"]>[number];

/**
 * Extract user-managed resources from Pi's prompt options in menu order.
 *
 * @param options - Prompt options for the current session.
 * @param contributedSkills - Project skill files this extension handed to Pi. Pi marks them
 *   `temporary`, the same scope as CLI skills, so membership is what makes them project skills.
 * @returns Global instructions, global skills, project instructions, then project skills.
 */
export function toggleResources(
  options: BuildSystemPromptOptions,
  contributedSkills: ReadonlySet<ResourcePath>,
): ReadonlyArray<ToggleResource> {
  const cwd = resourcePathId(options.cwd, options.cwd);
  const agentDirectory = resourcePathId(getAgentDir(), cwd);
  const globalSkillRoots = [join(agentDirectory, "skills"), join(homedir(), ".agents", "skills")];

  const instructions = (options.contextFiles ?? []).flatMap<ToggleResource>((file) => {
    const id = resourcePathId(file.path, cwd);
    const parent = dirname(id);
    const origin =
      parent === agentDirectory
        ? "global"
        : pathIsInsideOrEqual(cwd, parent)
          ? "project"
          : undefined;
    if (!origin) return [];
    const description = `${origin} instruction\n${id}`;
    return [
      {
        id,
        kind: "instruction",
        origin,
        label: basename(id),
        description,
        editability: "editable",
      },
    ];
  });
  const skills = (options.skills ?? [])
    .flatMap<ToggleResource>((skill) => {
      const id = resourcePathId(skill.filePath, cwd);
      const origin = skillOrigin(skill, id, globalSkillRoots, contributedSkills);
      if (!origin) return [];
      return [
        {
          id,
          kind: "skill",
          origin,
          label: skill.name.trim(),
          description: `${skill.description.trim() || "(no description)"}\n${id}`,
          editability: skill.disableModelInvocation ? "manual-only" : "editable",
        },
      ];
    })
    .sort(
      (left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id),
    );

  // Instructions keep Pi's discovery order and precede skills, so grouping by origin is enough.
  const unique = new Map<ResourcePath, ToggleResource>();
  for (const resource of [...instructions, ...skills]) {
    if (!unique.has(resource.id)) unique.set(resource.id, resource);
  }
  const resources = [...unique.values()];
  return (["global", "project"] as const).flatMap((origin) =>
    resources.filter((resource) => resource.origin === origin),
  );
}

/** Package, extension-owned, and CLI skills are not user-managed and have no origin. */
function skillOrigin(
  skill: PromptSkill,
  id: ResourcePath,
  globalSkillRoots: ReadonlyArray<string>,
  contributedSkills: ReadonlySet<ResourcePath>,
): ToggleResource["origin"] | undefined {
  if (skill.sourceInfo.origin !== "top-level") return undefined;
  switch (skill.sourceInfo.scope) {
    case "user":
      return globalSkillRoots.some((root) => pathIsInsideOrEqual(id, root)) ? "global" : undefined;
    case "project":
      return "project";
    case "temporary":
      return contributedSkills.has(id) ? "project" : undefined;
  }
}
