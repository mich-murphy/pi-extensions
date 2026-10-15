import { lstatSync, realpathSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve, sep } from "node:path";

export type ProjectGlossaryCandidate = {
  readonly repoRoot: string;
  readonly path: string;
  readonly canonicalPath: string;
};

export function findProjectGlossary(cwd: string): ProjectGlossaryCandidate | undefined {
  const cwdRoot = safeRealpath(resolve(cwd));
  if (cwdRoot === undefined || isHomeOrFilesystemRoot(cwdRoot)) {
    return undefined;
  }
  const root = findNearestGitRoot(cwdRoot) ?? cwdRoot;
  if (isHomeOrFilesystemRoot(root)) {
    return undefined;
  }
  return candidateAtRoot(root);
}

export function readApprovedProjectGlossary(
  candidate: ProjectGlossaryCandidate,
  approved: ReadonlySet<string>,
): string | undefined {
  if (!approved.has(candidate.canonicalPath)) {
    return undefined;
  }
  return readFileSync(candidate.canonicalPath, "utf8");
}

function candidateAtRoot(root: string): ProjectGlossaryCandidate | undefined {
  const path = join(root, ".pi", "terminology.json");
  const canonicalRoot = safeRealpath(root);
  if (canonicalRoot === undefined) {
    return undefined;
  }
  try {
    const linkStat = lstatSync(path, { throwIfNoEntry: false });
    if (linkStat === undefined) {
      return undefined;
    }
    const targetStat = statSync(path, { throwIfNoEntry: false });
    if (targetStat === undefined || !targetStat.isFile()) {
      return undefined;
    }
    const canonicalPath = realpathSync(path);
    if (!isContained(canonicalRoot, canonicalPath)) {
      return undefined;
    }
    return { repoRoot: canonicalRoot, path, canonicalPath };
  } catch {
    return undefined;
  }
}

function findNearestGitRoot(cwd: string): string | undefined {
  let current = resolve(cwd);
  const root = parse(current).root;
  const home = resolve(homedir());
  while (true) {
    if (current === home || current === root || current === dirname(current)) {
      return undefined;
    }
    if (hasGitMarker(current)) {
      return safeRealpath(current);
    }
    current = dirname(current);
  }
}

function hasGitMarker(directory: string): boolean {
  try {
    const gitStat = statSync(join(directory, ".git"), { throwIfNoEntry: false });
    return gitStat?.isDirectory() === true || gitStat?.isFile() === true;
  } catch {
    return false;
  }
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function isHomeOrFilesystemRoot(path: string): boolean {
  const resolved = resolve(path);
  return resolved === resolve(homedir()) || resolved === parse(resolved).root;
}

function isContained(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
