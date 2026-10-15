import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { RepositoryLocator } from "./repository";
import type { RepositoryLocation } from "./repository";
import { pathIsInsideOrEqual } from "./resource-path";
import type { ResourcePath } from "./resource-path";
import { toggleValue } from "./resources";
import type { ToggleOverrides, ToggleResource, ToggleValue } from "./resources";

/** File names Pi loads as instructions. */
export const INSTRUCTION_FILE_NAMES: ReadonlySet<string> = new Set([
  "AGENTS.md",
  "AGENTS.override.md",
  "CLAUDE.md",
]);

const SKILL_FILE = "SKILL.md";
const SKILL_FOLDER = /(?:^|\/)\.(?:agents|claude|codex|pi)\/skills\/(?<name>[^/]+)(?:\/|$)/u;

/**
 * Apply overrides to every worktree of a repository.
 *
 * An override is stored for one absolute path. A resource without its own override takes the
 * override of the same repository-relative path in another worktree of the same repository,
 * preferring the main checkout's.
 *
 * @returns Overrides keyed by each resource's own path, and the ids that inherited a value.
 */
export function effectiveOverrides(
  overrides: ToggleOverrides,
  resources: readonly Pick<ToggleResource, "id">[],
  locator = new RepositoryLocator(),
): { readonly overrides: ToggleOverrides; readonly inherited: ReadonlySet<ResourcePath> } {
  const byLocation = new Map<string, ToggleValue>();
  for (const [path, value] of overrides) {
    const location = locator.locate(path);
    if (location !== undefined && (location.main || !byLocation.has(locationKey(location)))) {
      byLocation.set(locationKey(location), value);
    }
  }
  const effective = new Map(overrides);
  const inherited = new Set<ResourcePath>();
  for (const { id } of resources) {
    const location = effective.has(id) ? undefined : locator.locate(id);
    const value = location === undefined ? undefined : byLocation.get(locationKey(location));
    if (value !== undefined) {
      effective.set(id, value);
      inherited.add(id);
    }
  }
  return { overrides: effective, inherited };
}

/** Disabled and explicitly enabled files the matcher compares paths against. */
type MatcherInput = {
  /** Folder names of disabled skills. They match under any skills root. */
  readonly skillNames: ReadonlySet<string>;
  /** Disabled files. Instructions also match the same repository-relative path in any worktree. */
  readonly disabledPaths: readonly string[];
  /** Instructions enabled explicitly, which another worktree's toggle must not override. */
  readonly enabledPaths: ReadonlySet<string>;
};

/** Decides whether a file belongs to a disabled instruction or skill. */
export type ResourceMatcher = {
  /** Name the disabled resource an absolute path belongs to, or return undefined. */
  readonly match: (path: string) => string | undefined;
};

class DisabledResourceMatcher implements ResourceMatcher {
  private readonly locator = new RepositoryLocator();
  private readonly disabledPaths: ReadonlySet<string>;
  private readonly disabledLocations: ReadonlySet<string>;

  constructor(private readonly input: MatcherInput) {
    this.disabledPaths = new Set(input.disabledPaths);
    this.disabledLocations = new Set(
      input.disabledPaths.flatMap((path) => {
        const location = INSTRUCTION_FILE_NAMES.has(basename(path))
          ? this.locator.locate(path)
          : undefined;
        return location === undefined ? [] : [locationKey(location)];
      }),
    );
  }

  /** Name the disabled resource an absolute path belongs to, or return undefined. */
  match(path: string): string | undefined {
    const skill = skillFolderName(path);
    if (skill !== undefined && this.input.skillNames.has(skill)) {
      return `skill "${skill}"`;
    }
    if (this.disabledPaths.has(path)) {
      return this.label(path);
    }
    if (!INSTRUCTION_FILE_NAMES.has(basename(path)) || this.input.enabledPaths.has(path)) {
      return undefined;
    }
    const location = this.locator.locate(path);
    return location !== undefined && this.disabledLocations.has(locationKey(location))
      ? location.path
      : undefined;
  }

  private label(path: string): string {
    return INSTRUCTION_FILE_NAMES.has(basename(path))
      ? (this.locator.locate(path)?.path ?? path)
      : path;
  }
}

/**
 * Build the matcher for the current toggle state.
 *
 * @param resources - Instructions and skills Pi loaded for the session.
 * @param overrides - Effective overrides, or undefined when state could not be loaded. Without
 *   state every listed resource counts as disabled, so a failure never exposes one.
 * @param manualSkills - Skill names the user invoked explicitly with `/skill:name`.
 */
export function disabledResourceMatcher(
  resources: readonly ToggleResource[],
  overrides: ToggleOverrides | undefined,
  manualSkills: ReadonlySet<string>,
): ResourceMatcher {
  const isDisabled = (resource: ToggleResource): boolean =>
    overrides === undefined || toggleValue(overrides, resource) === "disabled";
  const skills = resources.filter(
    (resource) => resource.kind === "skill" && !manualSkills.has(resource.label),
  );
  const inFolder = skills.filter((skill) => basename(skill.id) === SKILL_FILE);
  const enabledNames = new Set(
    inFolder.filter((skill) => !isDisabled(skill)).map((skill) => skillFolder(skill.id)),
  );
  const skillNames = new Set(
    inFolder
      .filter((skill) => isDisabled(skill))
      .map((skill) => skillFolder(skill.id))
      .filter((name) => !enabledNames.has(name)),
  );
  const disabledPaths = new Set<string>([
    ...skills.filter((skill) => !inFolder.includes(skill) && isDisabled(skill)).map(({ id }) => id),
    ...resources
      .filter((resource) => resource.kind === "instruction" && isDisabled(resource))
      .map(({ id }) => id),
  ]);
  const enabledPaths = new Set<string>();
  // Nested instructions Pi did not load can still be toggled from the menu.
  for (const [path, value] of overrides ?? []) {
    if (INSTRUCTION_FILE_NAMES.has(basename(path))) {
      (value === "disabled" ? disabledPaths : enabledPaths).add(path);
    }
  }
  return new DisabledResourceMatcher({
    skillNames,
    disabledPaths: [...disabledPaths],
    enabledPaths,
  });
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

/** A skill's folder name: the directory that holds its `SKILL.md`. */
function skillFolder(skillFile: string): string {
  return basename(dirname(skillFile));
}

function skillFolderName(path: string): string | undefined {
  const agentSkills = join(getAgentDir(), "skills");
  if (path !== agentSkills && pathIsInsideOrEqual(path, agentSkills)) {
    return relative(agentSkills, path).split("/")[0];
  }
  return SKILL_FOLDER.exec(path)?.groups?.name;
}

function locationKey(location: RepositoryLocation): string {
  return `${location.repository}\0${location.path}`;
}
