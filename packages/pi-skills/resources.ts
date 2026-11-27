import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { BuildSystemPromptOptions, SourceInfo } from "@earendil-works/pi-coding-agent";
import { instructionHeading } from "./instruction-heading";
import { RepositoryLocator } from "./repository";
import type { RepositoryLocation } from "./repository";
import { pathIsInsideOrEqual, resourcePathId } from "./resource-path";
import type { ResourcePath } from "./resource-path";

export type ToggleValue = "enabled" | "disabled";

export type ToggleOverrides = {
  readonly files: ReadonlyMap<ResourcePath, ToggleValue>;
  readonly repositories: ReadonlyMap<string, ReadonlyMap<string, ToggleValue>>;
};

export function emptyOverrides(): ToggleOverrides {
  return { files: new Map(), repositories: new Map() };
}

export function isGlobalResourcePath(path: string): boolean {
  return (
    pathIsInsideOrEqual(path, getAgentDir()) ||
    pathIsInsideOrEqual(path, join(homedir(), ".agents", "skills"))
  );
}

export class ResourcePolicy {
  private readonly locator = new RepositoryLocator();
  private readonly locations = new Map<string, RepositoryLocation | undefined>();

  constructor(readonly overrides: ToggleOverrides) {}

  override(path: ResourcePath, origin?: ToggleResource["origin"]): ToggleValue | undefined {
    const location = this.location(path, origin);

    return location === undefined
      ? this.overrides.files.get(path)
      : this.overrides.repositories.get(location.repository)?.get(location.path);
  }

  repositoryWide(resource: Pick<ToggleResource, "id" | "origin">): boolean {
    return this.location(resource.id, resource.origin) !== undefined;
  }

  locationKey(path: string): string | undefined {
    const location = this.location(path);

    return location === undefined ? undefined : `${location.repository}\0${location.path}`;
  }

  private location(path: string, origin?: ToggleResource["origin"]) {
    if (origin === "global") {
      return undefined;
    }

    if (!this.locations.has(path)) {
      this.locations.set(path, isGlobalResourcePath(path) ? undefined : this.locator.locate(path));
    }

    return this.locations.get(path);
  }

  value(resource: ToggleResource): ToggleValue {
    return resource.editability === "manual-only"
      ? "disabled"
      : (this.override(resource.id, resource.origin) ?? defaultToggleValue(resource));
  }
}

export type ToggleResource = {
  readonly id: ResourcePath;
  readonly kind: "instruction" | "skill";
  readonly origin: "global" | "project";
  readonly label: string;
  readonly description: string;
  readonly editability: "editable" | "manual-only";
};

export function isToggleValue(value: unknown): value is ToggleValue {
  return value === "enabled" || value === "disabled";
}

export function defaultToggleValue(resource: Pick<ToggleResource, "kind" | "origin">): ToggleValue {
  return resource.kind === "skill" && resource.origin === "project" ? "disabled" : "enabled";
}

export function toggleResources(
  options: BuildSystemPromptOptions,
  contributedSkills: ReadonlySet<ResourcePath>,
): ReadonlyArray<ToggleResource> {
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
  readonly globalSkillRoots: ReadonlyArray<string>;
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
