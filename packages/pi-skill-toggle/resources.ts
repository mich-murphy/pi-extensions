import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { BuildSystemPromptOptions, SourceInfo } from "@earendil-works/pi-coding-agent";
import { instructionHeading } from "./instruction-heading";
import { RepositoryLocator } from "./repository";
import type { RepositoryLocation } from "./repository";
import { pathIsInsideOrEqual, resourcePathId } from "./resource-path";
import type { ResourcePath } from "./resource-path";

/** Whether Pi advertises a resource to the model. */
export type ToggleValue = "enabled" | "disabled";

/** Explicit choices: discovery paths for global/outside files, repository-relative paths otherwise. */
export type ToggleOverrides = {
  readonly files: ReadonlyMap<ResourcePath, ToggleValue>;
  readonly repositories: ReadonlyMap<string, ReadonlyMap<string, ToggleValue>>;
};

/** An empty policy, with no explicit choices. */
export function emptyOverrides(): ToggleOverrides {
  return { files: new Map(), repositories: new Map() };
}

/** Known global discovery paths stay absolute even when the user's configuration is in Git. */
export function isGlobalResourcePath(path: string): boolean {
  return (
    pathIsInsideOrEqual(path, getAgentDir()) ||
    pathIsInsideOrEqual(path, join(homedir(), ".agents", "skills"))
  );
}

/** One policy resolver for the menu, prompt, and file guard. Create afresh after each load/save. */
export class ResourcePolicy {
  private readonly locator = new RepositoryLocator();
  /** Only this evaluation's lookups; fresh policies observe subsequent Git layout changes. */
  private readonly locations = new Map<string, RepositoryLocation | undefined>();

  constructor(readonly overrides: ToggleOverrides) {}

  /** Explicit choice for a loaded resource or an as-yet unloaded instruction/skill. */
  override(path: ResourcePath, origin?: ToggleResource["origin"]): ToggleValue | undefined {
    const location = this.location(path, origin);
    return location === undefined
      ? this.overrides.files.get(path)
      : this.overrides.repositories.get(location.repository)?.get(location.path);
  }

  /** Compare discovery paths using the same scope rule as explicit policy lookup. */
  sameResource(left: string, right: ResourcePath, origin: ToggleResource["origin"]): boolean {
    const a = this.location(left, origin);
    const b = this.location(right, origin);
    return a !== undefined && b !== undefined
      ? a.repository === b.repository && a.path === b.path
      : left === right;
  }

  /** Whether a choice is shared by every worktree, by the same rule persistence uses. */
  repositoryWide(resource: Pick<ToggleResource, "id" | "origin">): boolean {
    return this.location(resource.id, resource.origin) !== undefined;
  }

  private location(path: string, origin?: ToggleResource["origin"]) {
    // Check scope before using the path cache: global discovery paths never acquire repo identity.
    if (origin === "global" || isGlobalResourcePath(path)) {
      return undefined;
    }
    if (!this.locations.has(path)) {
      this.locations.set(path, this.locator.locate(path));
    }
    return this.locations.get(path);
  }

  /** Source-authored manual-only skills are never automatically available. */
  value(resource: ToggleResource): ToggleValue {
    return resource.editability === "manual-only"
      ? "disabled"
      : (this.override(resource.id, resource.origin) ?? defaultToggleValue(resource));
  }
}

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

  const locator = new RepositoryLocator();
  const instructions = (options.contextFiles ?? []).flatMap<ToggleResource>((file) => {
    const id = resourcePathId(file.path, cwd);
    const origin = instructionOrigin({ parent: dirname(id), agentDirectory, cwd });
    if (!origin) {
      return [];
    }
    const location = origin === "project" ? locator.locate(id) : undefined;
    return [
      {
        id,
        kind: "instruction",
        origin,
        label: location?.path ?? basename(id),
        description: instructionHeading(file.content, id),
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
          description: skill.description,
          editability: skill.disableModelInvocation ? "manual-only" : "editable",
        },
      ];
    })
    .toSorted(
      (left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id),
    );

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
      const _exhaustive: never = sourceInfo.scope;
      void _exhaustive;
      return undefined;
    }
  }
}
