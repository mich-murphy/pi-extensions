import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { BuildSystemPromptOptions, SourceInfo } from "@earendil-works/pi-coding-agent";
import { pathIsInsideOrEqual, resourcePathId } from "./resource-path";
import type { ResourcePath } from "./resource-path";

/** Whether Pi advertises a resource to the model. */
export type ToggleValue = "enabled" | "disabled";

/** User choices that differ from a resource's default, keyed by resource path. */
export type ToggleOverrides = ReadonlyMap<ResourcePath, ToggleValue>;

/** A user-managed instruction file or skill that appears in the toggle menu. */
export type ToggleResource = {
  readonly id: ResourcePath;
  readonly kind: "instruction" | "skill";
  /** Menu group. Global resources are listed before project resources. */
  readonly origin: "global" | "project";
  readonly label: string;
  readonly description: string;
  /** Skills that declare `disable-model-invocation` are shown but never toggled. */
  readonly editability: "editable" | "manual-only";
};

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
): readonly ToggleResource[] {
  const cwd = resourcePathId(options.cwd, options.cwd);
  const agentDirectory = resourcePathId(getAgentDir(), cwd);
  const globalSkillRoots = [join(agentDirectory, "skills"), join(homedir(), ".agents", "skills")];

  const instructions = (options.contextFiles ?? []).flatMap<ToggleResource>((file) => {
    const id = resourcePathId(file.path, cwd);
    const origin = instructionOrigin({ parent: dirname(id), agentDirectory, cwd });
    if (!origin) {
      return [];
    }
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
      const origin = skillOrigin({
        sourceInfo: skill.sourceInfo,
        id,
        globalSkillRoots,
        contributedSkills,
      });
      if (!origin) {
        return [];
      }
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
    .toSorted(
      (left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id),
    );

  // Instructions keep Pi's discovery order and precede skills, so grouping by origin is enough.
  const unique = new Map<ResourcePath, ToggleResource>();
  for (const resource of [...instructions, ...skills]) {
    if (!unique.has(resource.id)) {
      unique.set(resource.id, resource);
    }
  }
  const resources = [...unique.values()];
  return (["global", "project"] as const).flatMap((origin) =>
    resources.filter((resource) => resource.origin === origin),
  );
}

/** An instruction in the agent directory is global, one in `cwd` or an ancestor is project. */
function instructionOrigin({
  parent,
  agentDirectory,
  cwd,
}: {
  readonly parent: string;
  readonly agentDirectory: string;
  readonly cwd: string;
}): ToggleResource["origin"] | undefined {
  if (parent === agentDirectory) {
    return "global";
  }
  return pathIsInsideOrEqual(cwd, parent) ? "project" : undefined;
}

/** Package, extension-owned, and CLI skills are not user-managed and have no origin. */
function skillOrigin({
  sourceInfo,
  id,
  globalSkillRoots,
  contributedSkills,
}: {
  readonly sourceInfo: Readonly<SourceInfo>;
  readonly id: ResourcePath;
  readonly globalSkillRoots: readonly string[];
  readonly contributedSkills: ReadonlySet<ResourcePath>;
}): ToggleResource["origin"] | undefined {
  if (sourceInfo.origin !== "top-level") {
    return undefined;
  }
  switch (sourceInfo.scope) {
    case "user": {
      return globalSkillRoots.some((root) => pathIsInsideOrEqual(id, root)) ? "global" : undefined;
    }
    case "project": {
      return "project";
    }
    case "temporary": {
      return contributedSkills.has(id) ? "project" : undefined;
    }
    default: {
      // A scope added by a later Pi release is not user-managed.
      const _exhaustive: never = sourceInfo.scope;
      void _exhaustive;
      return undefined;
    }
  }
}
