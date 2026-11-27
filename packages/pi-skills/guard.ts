import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RepositoryLocator } from "./repository";
import { resourcePathId } from "./resource-path";
import type { ResourcePath } from "./resource-path";
import { emptyOverrides, ResourcePolicy } from "./resources";
import type { ToggleOverrides, ToggleResource } from "./resources";

export const INSTRUCTION_FILE_NAMES: ReadonlySet<string> = new Set([
  "AGENTS.md",
  "AGENTS.MD",
  "AGENTS.override.md",
  "CLAUDE.md",
  "CLAUDE.MD",
]);

export type ResourceMatcher = {
  readonly match: (path: string) => string | undefined;
};

type SkillOwner = { readonly resource: ToggleResource } | { readonly disabledSkill: string };

export function disabledResourceMatcher(
  resources: ReadonlyArray<ToggleResource>,
  overrides: ToggleOverrides | undefined,
  manualSkills: ReadonlySet<string>,
  decide?: (resource: ToggleResource) => boolean | undefined,
): ResourceMatcher {
  const policy = new ResourcePolicy(overrides ?? emptyOverrides());

  const disabled = (resource: ToggleResource): boolean =>
    decide?.(resource) ?? (overrides === undefined || policy.value(resource) === "disabled");

  const canonical = canonicalizer();

  const loadedOnDisk = lazy(
    () =>
      new Map(
        resources
          .toReversed()
          .map((resource) => [onDiskKey(resource.kind, canonical(resource.id)), resource]),
      ),
  );

  const loadedIndex = lazy(() => cachedResourceIndex(resources, policy));

  const loadedAt = (path: string, kind: ToggleResource["kind"]): ToggleResource | undefined => {
    const { byId, byLocation } = loadedIndex();
    const location = policy.locationKey(path);
    const exact = byId.get(onDiskKey(kind, path));
    const located = location === undefined ? undefined : byLocation.get(onDiskKey(kind, location));
    const index = Math.min(exact ?? Infinity, located ?? Infinity);

    return resources[index] ?? loadedOnDisk().get(onDiskKey(kind, canonical(path)));
  };

  const skillOwner = (id: string): SkillOwner | undefined => {
    const exact = loadedAt(id, "skill");

    if (exact !== undefined && basename(exact.id) !== "SKILL.md") {
      return { resource: exact };
    }

    for (let directory = dirname(id); ; directory = dirname(directory)) {
      const skillFile = resourcePathId(join(directory, "SKILL.md"), "/");
      const loaded = loadedAt(skillFile, "skill");

      if (loaded !== undefined) {
        return { resource: loaded };
      }

      if (policy.override(skillFile) === "disabled") {
        return { disabledSkill: basename(directory) };
      }

      if (dirname(directory) === directory) {
        return undefined;
      }
    }
  };

  const matchId = (id: ResourcePath): string | undefined => {
    const instruction = loadedAt(id, "instruction");

    if (
      instruction
        ? disabled(instruction)
        : INSTRUCTION_FILE_NAMES.has(basename(id)) && policy.override(id) === "disabled"
    ) {
      return instructionLabel(instruction?.id ?? id);
    }

    const owner = skillOwner(id);

    if (owner === undefined) {
      return undefined;
    }

    if ("resource" in owner) {
      const skill = owner.resource;

      return !manualSkills.has(skill.label) && disabled(skill)
        ? `skill "${skill.label}"`
        : undefined;
    }

    return `skill "${owner.disabledSkill}"`;
  };

  const linkedCandidates = lazy(() =>
    hardLinkIndex([...resources.map((resource) => resource.id), ...persistedPaths(overrides)]),
  );

  const hardLinkMatch = (path: string): string | undefined => {
    const identity = fileIdentity(path);

    for (const candidate of identity === undefined
      ? []
      : (linkedCandidates().get(identity) ?? [])) {
      const label = matchId(candidate);

      if (label !== undefined) {
        return label;
      }
    }

    return undefined;
  };

  return {
    match: (path) => {
      const id = resourcePathId(path, "/");
      const onDisk = resourcePathId(canonical(id), "/");

      return matchId(id) ?? (onDisk === id ? undefined : matchId(onDisk)) ?? hardLinkMatch(onDisk);
    },
  };
}

type ResourceIndex = {
  readonly byId: ReadonlyMap<string, number>;
  readonly byLocation: ReadonlyMap<string, number>;
};

function resourceIndex(
  resources: ReadonlyArray<ToggleResource>,
  policy: ResourcePolicy,
): ResourceIndex {
  const byId = new Map<string, number>();
  const byLocation = new Map<string, number>();

  for (const [index, resource] of resources.entries()) {
    const location = resource.origin === "global" ? undefined : policy.locationKey(resource.id);
    const target = location === undefined ? byId : byLocation;
    const key = onDiskKey(resource.kind, location ?? resource.id);

    if (!target.has(key)) {
      target.set(key, index);
    }
  }

  return { byId, byLocation };
}

const RESOURCE_INDEXES = new WeakMap<ReadonlyArray<ToggleResource>, ResourceIndex>();

function cachedResourceIndex(
  resources: ReadonlyArray<ToggleResource>,
  policy: ResourcePolicy,
): ResourceIndex {
  const cached = RESOURCE_INDEXES.get(resources);

  if (cached !== undefined) {
    return cached;
  }

  const index = resourceIndex(resources, policy);
  RESOURCE_INDEXES.set(resources, index);

  return index;
}

function persistedPaths(overrides: ToggleOverrides | undefined): ReadonlyArray<string> {
  return [
    ...(overrides?.files.keys() ?? []),
    ...[...(overrides?.repositories ?? [])].flatMap(([repository, choices]) =>
      [...choices.keys()].map((path) => join(dirname(repository), path)),
    ),
  ];
}

function fileIdentity(path: string): string | undefined {
  try {
    const stats = statSync(path, { bigint: true });

    return stats.nlink > 1n && stats.isFile() ? `${stats.dev}:${stats.ino}` : undefined;
  } catch {
    return undefined;
  }
}

function hardLinkIndex(paths: Iterable<string>): ReadonlyMap<string, ReadonlyArray<ResourcePath>> {
  const index = new Map<string, Array<ResourcePath>>();

  for (const path of new Set(paths)) {
    const identity = fileIdentity(path);

    if (identity !== undefined) {
      index.set(identity, [...(index.get(identity) ?? []), resourcePathId(path, "/")]);
    }
  }

  return index;
}

const onDiskKey = (kind: ToggleResource["kind"], path: string): string => `${kind}\0${path}`;

function lazy<T>(make: () => T): () => T {
  let value: { readonly current: T } | undefined;

  return () => {
    value ??= { current: make() };

    return value.current;
  };
}

function canonicalizer(): (path: string) => string {
  const cache = new Map<string, string>();

  const canonical = (path: string): string => {
    const cached = cache.get(path);

    if (cached !== undefined) {
      return cached;
    }

    const parent = dirname(path);

    const result =
      realPath(path) ?? (parent === path ? path : join(canonical(parent), basename(path)));

    cache.set(path, result);

    return result;
  };

  return canonical;
}

function realPath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;

export function toolPath(path: string, cwd: string): string {
  const spaced = path.replaceAll(UNICODE_SPACES, " ");
  const withoutAt = spaced.startsWith("@") ? spaced.slice(1) : spaced;

  return resolve(cwd, expandHome(withoutAt) ?? fileUrlPath(withoutAt) ?? withoutAt);
}

function expandHome(path: string): string | undefined {
  if (path === "~") {
    return homedir();
  }

  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : undefined;
}

function fileUrlPath(path: string): string | undefined {
  if (!path.startsWith("file://")) {
    return undefined;
  }

  try {
    return fileURLToPath(path);
  } catch {
    return undefined;
  }
}

const instructionLabel = (path: string): string =>
  new RepositoryLocator().locate(path)?.path ?? path;
