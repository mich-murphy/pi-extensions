import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CONFIG_DIR_NAME,
  DefaultPackageManager,
  getAgentDir,
  loadSkills,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

function supplementalSkillDirectories(cwd: string): readonly string[] {
  return directoriesThroughGitRoot(cwd).flatMap((directory) => [
    ...(directory === cwd ? [] : [join(directory, CONFIG_DIR_NAME, "skills")]),
    join(directory, ".claude", "skills"),
    join(directory, ".codex", "skills"),
  ]);
}

type NativeSkillReservations = {
  readonly collisionWinnerNames: ReadonlySet<string>;
  readonly excludedSkillNames: ReadonlySet<string>;
};

function skillNamesAtPaths(
  cwd: string,
  agentDir: string,
  skillPaths: string[],
): ReadonlySet<string> {
  return new Set(
    loadSkills({ cwd, agentDir, skillPaths, includeDefaults: false }).skills.map(
      (skill) => skill.name,
    ),
  );
}

/**
 * Load Pi's actual native winners without installing a missing package.
 *
 * DefaultPackageManager owns native roots, settings exclusions, package filters, and ordering.
 * Returning `skip` for a missing package keeps this inspection local and side-effect free.
 */
async function reservedNativeSkillNames(
  cwd: string,
  agentDir: string,
): Promise<NativeSkillReservations> {
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  await settingsManager.reload();
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const resolved = await packageManager.resolve(async () => "skip");
  return {
    collisionWinnerNames: skillNamesAtPaths(
      cwd,
      agentDir,
      resolved.skills.filter((resource) => resource.enabled).map((resource) => resource.path),
    ),
    excludedSkillNames: skillNamesAtPaths(
      cwd,
      agentDir,
      resolved.skills.filter((resource) => !resource.enabled).map((resource) => resource.path),
    ),
  };
}

/**
 * Find supplemental project skills from the working directory through the Git root.
 *
 * Pi 0.85 and every supported later release already discover cwd `.pi/skills`, ancestor
 * `.agents/skills`, the agent directory, and home `.agents/skills`. Those roots are deliberately
 * not submitted again. Native winners also keep their names ahead of supplemental copies.
 */
export async function discoverProjectSkillPaths(
  cwd: string,
  agentDir = getAgentDir(),
  loadedNativeNames: ReadonlySet<string> = new Set(),
): Promise<readonly string[]> {
  const roots = supplementalSkillDirectories(cwd).filter((path) => existsSync(path));
  if (roots.length === 0) {
    return [];
  }

  const result = loadSkills({
    cwd,
    agentDir,
    skillPaths: roots,
    includeDefaults: false,
  });
  const reservations = await reservedNativeSkillNames(cwd, agentDir);
  const nativeNames = new Set([
    ...reservations.collisionWinnerNames,
    ...reservations.excludedSkillNames,
    ...loadedNativeNames,
  ]);
  const invalidPaths = new Set(
    result.diagnostics.flatMap((diagnostic) =>
      diagnostic.type !== "collision" && diagnostic.path !== undefined && diagnostic.path !== ""
        ? [diagnostic.path]
        : [],
    ),
  );
  return result.skills
    .filter((skill) => !invalidPaths.has(skill.filePath) && !nativeNames.has(skill.name))
    .map((skill) => skill.filePath);
}

function directoriesThroughGitRoot(cwd: string): readonly string[] {
  const directories: string[] = [];
  for (let directory = cwd; ; directory = dirname(directory)) {
    directories.push(directory);
    if (existsSync(join(directory, ".git"))) {
      return directories;
    }
    if (dirname(directory) === directory) {
      return [cwd];
    }
  }
}
