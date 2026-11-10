import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
 *
 * @param decide - Optional decision for a loaded resource, such as a subagent's parent session's;
 *   undefined falls back to the session's own state.
 */
export function disabledResourceMatcher(
  resources: readonly ToggleResource[],
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
  // Candidates for hard-link matching: every named resource file, loaded or only persisted.
  const linkedCandidates = lazy(() =>
    hardLinkIndex([...resources.map((resource) => resource.id), ...persistedPaths(overrides)]),
  );
  /** A second name for a protected file: same device and inode as a disabled resource file. */
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
      // The on-disk form catches case variants on case-insensitive file systems and symlinks to
      // protected files. It only differs from the lexical path when both name the same file, so
      // case-sensitive file systems keep distinct `agents.md` and `AGENTS.md` files separate.
      const onDisk = resourcePathId(canonical(id), "/");
      return matchId(id) ?? (onDisk === id ? undefined : matchId(onDisk)) ?? hardLinkMatch(onDisk);
    },
  };
}

/** Absolute paths of every explicit choice; repository choices resolve in the main checkout. */
function persistedPaths(overrides: ToggleOverrides | undefined): readonly string[] {
  return [
    ...(overrides?.files.keys() ?? []),
    ...[...(overrides?.repositories ?? [])].flatMap(([repository, choices]) =>
      [...choices.keys()].map((path) => join(dirname(repository), path)),
    ),
  ];
}

/**
 * `device:inode` of a file that has other names, else undefined. Ordinary single-link files
 * cost one `stat` and never reach the (lazily built) index of protected files' identities.
 */
function fileIdentity(path: string): string | undefined {
  try {
    const stats = statSync(path, { bigint: true });
    return stats.nlink > 1n && stats.isFile() ? `${stats.dev}:${stats.ino}` : undefined;
  } catch {
    return undefined;
  }
}

/** Resource files that have more than one name, grouped by identity. */
function hardLinkIndex(paths: Iterable<string>): ReadonlyMap<string, readonly ResourcePath[]> {
  const index = new Map<string, ResourcePath[]>();
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

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;

/**
 * Resolve a path argument the way Pi's file tools do (`resolvePath` in Pi's `utils/paths`):
 * Unicode spaces, `@` prefix, `~` or `~/`, `file://` URL, then the cwd. An unparseable URL is
 * unreadable for Pi, so it is left as an ordinary relative path.
 */
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
