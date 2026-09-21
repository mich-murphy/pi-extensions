import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, loadSkills } from "@earendil-works/pi-coding-agent";

/** Project-local skill directories understood by Pi and other common agent clients. */
const PROJECT_SKILL_DIRECTORIES = [
  join(CONFIG_DIR_NAME, "skills"),
  join(".agents", "skills"),
  join(".claude", "skills"),
  join(".codex", "skills"),
];

/**
 * Find project skills from the working directory through the Git root.
 *
 * Pi receives individual files so mirrored harness directories cannot produce
 * name-collision diagnostics. Earlier roots win, while uniquely named skills
 * from later roots remain available.
 */
export function discoverProjectSkillPaths(cwd: string): ReadonlyArray<string> {
  const roots = directoriesThroughGitRoot(cwd).flatMap((directory) =>
    PROJECT_SKILL_DIRECTORIES.map((skills) => join(directory, skills)).filter(existsSync),
  );
  if (roots.length === 0) return [];

  const result = loadSkills({
    cwd,
    agentDir: getAgentDir(),
    skillPaths: roots,
    includeDefaults: false,
  });
  const invalidPaths = new Set(
    result.diagnostics.flatMap((diagnostic) =>
      diagnostic.type !== "collision" && diagnostic.path ? [diagnostic.path] : [],
    ),
  );
  return result.skills
    .filter((skill) => !invalidPaths.has(skill.filePath))
    .map((skill) => skill.filePath);
}

/** Outside a Git worktree only `cwd` counts, so a parent user's skills are not claimed. */
function directoriesThroughGitRoot(cwd: string): ReadonlyArray<string> {
  const directories: string[] = [];
  for (let directory = cwd; ; directory = dirname(directory)) {
    directories.push(directory);
    if (existsSync(join(directory, ".git"))) return directories;
    if (dirname(directory) === directory) return [cwd];
  }
}
