import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export type RepositoryLocation = {
  readonly repository: string;
  readonly path: string;
  readonly main: boolean;
};

type Worktree = { readonly root: string; readonly repository: string; readonly main: boolean };

export class RepositoryLocator {
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

  worktreeRoot(directory: string): string | undefined {
    return this.worktreeOf(directory)?.root;
  }

  private worktreeOf(directory: string): Worktree | undefined {
    for (let current = directory; ; current = dirname(current)) {
      const worktree = gitWorktreeAt(current);
      if (worktree !== undefined) {
        return worktree;
      }
      if (dirname(current) === current) {
        return undefined;
      }
    }
  }
}

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
  if (entryKind(worktreeGitDirectory) !== "directory") {
    return undefined;
  }
  const commonDirectory = readText(join(worktreeGitDirectory, "commondir"))?.trim();
  return {
    root: directory,
    main: commonDirectory === undefined || commonDirectory === "",
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
