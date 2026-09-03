import { existsSync } from "node:fs";
import { dirname, join, parse, relative } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  loadSkills,
  type ResourceDiagnostic,
} from "@earendil-works/pi-coding-agent";
import { pathIsInsideOrEqual } from "./resource-path";

/** Project-local skill directories understood by Pi and other common agent clients. */
export const PROJECT_SKILL_RELATIVE_PATHS = [
  [CONFIG_DIR_NAME, "skills"],
  [".agents", "skills"],
  [".claude", "skills"],
  [".codex", "skills"],
] as const;

/**
 * Find project skills from the working directory through the Git root.
 *
 * Pi receives individual files so mirrored harness directories cannot produce
 * name-collision diagnostics. Earlier roots win, while uniquely named skills
 * from later roots remain available.
 */
export function discoverProjectSkillPaths(cwd: string): ReadonlyArray<string> {
  const projectRoot = findGitRoot(cwd);
  const directories = directoriesThroughRoot(cwd, projectRoot ?? cwd);
  const roots = directories.flatMap((directory) =>
    PROJECT_SKILL_RELATIVE_PATHS.map((parts) => join(directory, ...parts)).filter(existsSync),
  );
  if (roots.length === 0) return [];

  const result = loadSkills({
    cwd,
    agentDir: getAgentDir(),
    skillPaths: roots,
    includeDefaults: false,
  });
  const selectedPaths = result.skills.map((skill) => skill.filePath);
  const selected = new Set(selectedPaths);
  const collisionLosers = new Set(
    result.diagnostics.flatMap((diagnostic) =>
      diagnostic.collision ? [diagnostic.collision.loserPath] : [],
    ),
  );
  const diagnosticPaths = uniqueDiagnosticPaths(
    result.diagnostics,
    roots,
    selected,
    collisionLosers,
  );
  return [...selectedPaths, ...diagnosticPaths];
}

function uniqueDiagnosticPaths(
  diagnostics: ReadonlyArray<ResourceDiagnostic>,
  roots: ReadonlyArray<string>,
  selected: ReadonlySet<string>,
  collisionLosers: ReadonlySet<string>,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const diagnostic of diagnostics) {
    const path = diagnostic.path;
    if (
      !(path && diagnostic.type !== "collision") ||
      selected.has(path) ||
      collisionLosers.has(path)
    ) {
      continue;
    }
    const key = relativeToOwningRoot(path, roots);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
  }
  return paths;
}

function relativeToOwningRoot(path: string, roots: ReadonlyArray<string>): string {
  const root = roots.find((candidate) => pathIsInsideOrEqual(path, candidate));
  return root ? relative(root, path) : path;
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
