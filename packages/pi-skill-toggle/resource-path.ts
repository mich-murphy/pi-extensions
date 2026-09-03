import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import process from "node:process";

declare const resourcePathBrand: unique symbol;

/** Absolute normalized identity for a Pi-loaded resource or its owner directory. */
export type ResourcePath = string & { readonly [resourcePathBrand]: true };

/** Parse a resource path into an absolute identity without dereferencing symlinks. */
export function resourcePathId(path: string, cwd = process.cwd()): ResourcePath {
  // SAFETY: resolve() makes the path absolute and normalize() removes lexical ambiguity. The brand is private to this parser.
  return normalize(resolve(cwd, path)) as ResourcePath;
}

/** Whether a path is lexically inside a parent path or equal to it. */
export function pathIsInsideOrEqual(path: string, parent: string): boolean {
  const difference = relative(parent, path);
  return (
    difference === "" ||
    (difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
  );
}
