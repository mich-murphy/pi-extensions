import { isAbsolute, relative, resolve, sep } from "node:path";

declare const resourcePathBrand: unique symbol;

/** Absolute normalized identity for a Pi-loaded resource. */
export type ResourcePath = string & { readonly [resourcePathBrand]: true };

/** Resolve a path against a working directory into an identity without dereferencing symlinks. */
export function resourcePathId(path: string, cwd: string): ResourcePath {
  // SAFETY: resolve() returns an absolute, lexically normalized path. Only this module brands.
  return resolve(cwd, path) as ResourcePath;
}

/** Parse a persisted path, which must already be absolute. */
export function parseResourcePath(path: string): ResourcePath | undefined {
  return isAbsolute(path) ? resourcePathId(path, path) : undefined;
}

/** Whether a path is lexically inside a parent path or equal to it. */
export function pathIsInsideOrEqual(path: string, parent: string): boolean {
  const difference = relative(parent, path);
  return (
    difference === "" ||
    (difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
  );
}
