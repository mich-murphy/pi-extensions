import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { RepositoryLocator } from "./repository";
import { resourcePathId } from "./resource-path";
import type { ResourcePath } from "./resource-path";
import { emptyOverrides, ResourcePolicy } from "./resources";
import type { ToggleOverrides, ToggleResource } from "./resources";

/** File names Pi loads as instructions. */
export const INSTRUCTION_FILE_NAMES: ReadonlySet<string> = new Set([
  "AGENTS.md",
  "AGENTS.MD",
  "AGENTS.override.md",
  "CLAUDE.md",
  "CLAUDE.MD",
]);

/** Decides whether a file belongs to a disabled instruction or skill. */
export type ResourceMatcher = {
  /** Name the disabled resource an absolute path belongs to, or return undefined. */
  readonly match: (path: string) => string | undefined;
};

/** The nearest skill directory or exact standalone skill owns a read. */
type SkillOwner = { readonly resource: ToggleResource } | { readonly disabledSkill: string };

/**
 * Match actual skill directories, not folder names under guessed skill roots. Walking parents
 * also finds persisted disabled SKILL.md paths when that skill is not currently loaded.
 * Repository equivalence and explicit choices always go through the same policy as the UI.
 */
export function disabledResourceMatcher(
  resources: readonly ToggleResource[],
  overrides: ToggleOverrides | undefined,
  manualSkills: ReadonlySet<string>,
): ResourceMatcher {
  const policy = new ResourcePolicy(overrides ?? emptyOverrides());
  const disabled = (resource: ToggleResource): boolean =>
    overrides === undefined || policy.value(resource) === "disabled";
  const canonical = canonicalizer();
  const loadedOnDisk = lazy(
    () =>
      // Reversed so the first loaded resource wins, matching `find` below.
      new Map(
        resources
          .toReversed()
          .map((resource) => [onDiskKey(resource.kind, canonical(resource.id)), resource]),
      ),
  );
  const loadedAt = (path: string, kind: ToggleResource["kind"]): ToggleResource | undefined =>
    resources.find(
      (resource) =>
        resource.kind === kind && policy.sameResource(path, resource.id, resource.origin),
    ) ?? loadedOnDisk().get(onDiskKey(kind, canonical(path)));
  const skillOwner = (id: string): SkillOwner | undefined => {
    // Most-specific ownership keeps explicitly configured nested skills and standalone
    // helpers independent of an outer skill's toggle, just like their menu/prompt rows.
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
    // Pi can load uppercase and explicitly supplied context files too. Loaded identity,
    // rather than a filename allowlist, determines whether those reads are protected.
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
      // Explicit invocation is local to this session and this actual loaded skill.
      return !manualSkills.has(skill.label) && disabled(skill)
        ? `skill "${skill.label}"`
        : undefined;
    }
    return `skill "${owner.disabledSkill}"`;
  };
  return {
    match: (path) => {
      const id = resourcePathId(path, "/");
      // The on-disk form catches case variants on case-insensitive file systems and symlinks to
      // protected files. It only differs from the lexical path when both name the same file, so
      // case-sensitive file systems keep distinct `agents.md` and `AGENTS.md` files separate.
      const onDisk = resourcePathId(canonical(id), "/");
      return matchId(id) ?? (onDisk === id ? undefined : matchId(onDisk));
    },
  };
}

const onDiskKey = (kind: ToggleResource["kind"], path: string): string => `${kind}\0${path}`;

function lazy<T>(make: () => T): () => T {
  let value: { readonly current: T } | undefined;
  return () => {
    value ??= { current: make() };
    return value.current;
  };
}

/**
 * Memoised on-disk identity: the real path, or the real path of the nearest existing ancestor
 * plus the missing suffix. `realpathSync.native` reports stored casing on case-insensitive file
 * systems, unlike the JavaScript `realpathSync`, which echoes the caller's casing.
 */
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

/** Resolve a path argument the way Pi's file tools do: `@` prefix, then `~`, then the cwd. */
export function toolPath(path: string, cwd: string): string {
  const withoutAt = path.startsWith("@") ? path.slice(1) : path;
  const expanded =
    withoutAt === "~" || withoutAt.startsWith("~/")
      ? join(homedir(), withoutAt.slice(1))
      : withoutAt;
  return resolve(cwd, expanded);
}

const instructionLabel = (path: string): string =>
  new RepositoryLocator().locate(path)?.path ?? path;
