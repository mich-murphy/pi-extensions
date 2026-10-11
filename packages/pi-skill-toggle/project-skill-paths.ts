import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CONFIG_DIR_NAME,
  DefaultPackageManager,
  getAgentDir,
  loadSkills,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

/** Supplemental project skill directories that Pi does not discover natively. */
function supplementalSkillDirectories(cwd: string): readonly string[] {
  return directoriesThroughGitRoot(cwd).flatMap((directory) => [
    // Pi loads only cwd/.pi/skills. An ancestor .pi/skills remains supplemental.
    ...(directory === cwd ? [] : [join(directory, CONFIG_DIR_NAME, "skills")]),
    join(directory, ".claude", "skills"),
    join(directory, ".codex", "skills"),
  ]);
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
): Promise<ReadonlySet<string>> {
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  await settingsManager.reload();
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const resolved = await packageManager.resolve(async () => "skip");
  const names = new Set<string>();
  // Enabled paths reserve Pi's actual collision winners. Disabled paths reserve explicitly excluded
  // names so a copy from another harness cannot silently reintroduce the excluded skill.
  for (const enabled of [true, false]) {
    const loaded = loadSkills({
      cwd,
      agentDir,
      skillPaths: resolved.skills
        .filter((resource) => resource.enabled === enabled)
        .map((resource) => resource.path),
      includeDefaults: false,
    });
    for (const skill of loaded.skills) {
      names.add(skill.name);
    }
  }
  return names;
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
  const nativeNames = await reservedNativeSkillNames(cwd, agentDir);
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

/** Outside a Git worktree only `cwd` counts, so a parent user's skills are not claimed. */
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
