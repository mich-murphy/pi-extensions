import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

/** Project-local skill directories understood by Pi and other common agent clients. */
export const PROJECT_SKILL_RELATIVE_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
  [CONFIG_DIR_NAME, "skills"],
  [".agents", "skills"],
  [".claude", "skills"],
  [".codex", "skills"],
];

/** Find project skill directories from the working directory through the Git root. */
export function discoverProjectSkillPaths(cwd: string): ReadonlyArray<string> {
  const projectRoot = findGitRoot(cwd);
  const directories = directoriesThroughRoot(cwd, projectRoot ?? cwd);
  return directories.flatMap((directory) =>
    PROJECT_SKILL_RELATIVE_PATHS.map((parts) => join(directory, ...parts)).filter(existsSync),
  );
}

function findGitRoot(cwd: string): string | undefined {
  let directory = cwd;
  const filesystemRoot = parse(cwd).root;
  while (true) {
    if (existsSync(join(directory, ".git"))) return directory;
    if (directory === filesystemRoot) return undefined;
    directory = dirname(directory);
  }
}

function directoriesThroughRoot(cwd: string, root: string): ReadonlyArray<string> {
  const directories: string[] = [];
  let directory = cwd;
  while (true) {
    directories.push(directory);
    if (directory === root) return directories;
    const parent = dirname(directory);
    if (parent === directory) return directories;
    directory = parent;
  }
}
