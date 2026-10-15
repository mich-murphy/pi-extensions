import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** Where a file sits in a Git repository. Every worktree of the repository shares this location. */
export type RepositoryLocation = {
  /** Canonical common Git directory shared by the repository's worktrees. */
  readonly repository: string;
  /** Path relative to the root of the worktree that holds the file. */
  readonly path: string;
  /** Whether the file is in the main checkout rather than a linked worktree. */
  readonly main: boolean;
};

type Worktree = { readonly root: string; readonly repository: string; readonly main: boolean };

/**
 * Find the Git worktree and repository that hold a path by reading `.git` entries directly.
 *
 * Lookups are cached per directory and never refreshed, so create one locator per evaluation.
 */
export class RepositoryLocator {
  private readonly worktrees = new Map<string, Worktree | undefined>();

  /** The repository location of an absolute path, or undefined outside a Git worktree. */
  locate(path: string): RepositoryLocation | undefined {
    const worktree = this.worktreeOf(dirname(path));
    return worktree === undefined
      ? undefined
      : {
          repository: worktree.repository,
          path: relative(worktree.root, path),
          main: worktree.main,
        };
  }

  /** Root of the Git worktree that holds an absolute directory. */
  worktreeRoot(directory: string): string | undefined {
    return this.worktreeOf(directory)?.root;
  }

  private worktreeOf(directory: string): Worktree | undefined {
    if (this.worktrees.has(directory)) {
      return this.worktrees.get(directory);
    }
    const parent = dirname(directory);
    const worktree =
      gitWorktreeAt(directory) ?? (parent === directory ? undefined : this.worktreeOf(parent));
    this.worktrees.set(directory, worktree);
    return worktree;
  }
}

/** A main checkout has a `.git` folder; a linked worktree has a `.git` file naming its Git folder. */
function gitWorktreeAt(directory: string): Worktree | undefined {
  const entry = join(directory, ".git");
  const kind = entryKind(entry);
  if (kind === "directory") {
    return { root: directory, repository: canonical(entry), main: true };
  }
  if (kind !== "file") {
    return undefined;
  }
  const gitDirectory = /^gitdir:\s*(?<path>.+)$/mu.exec(readText(entry) ?? "")?.groups?.path;
  if (gitDirectory === undefined) {
    return undefined;
  }
  const worktreeGitDirectory = resolve(directory, gitDirectory.trim());
  const commonDirectory = readText(join(worktreeGitDirectory, "commondir"))?.trim();
  return {
    root: directory,
    main: false,
    repository: canonical(
      commonDirectory === undefined || commonDirectory === ""
        ? worktreeGitDirectory
        : resolve(worktreeGitDirectory, commonDirectory),
    ),
  };
}

function entryKind(path: string): "directory" | "file" | undefined {
  try {
    const stats = statSync(path, { throwIfNoEntry: false });
    if (stats?.isDirectory() === true) {
      return "directory";
    }
    return stats?.isFile() === true ? "file" : undefined;
  } catch {
    return undefined;
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
