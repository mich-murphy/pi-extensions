import { isAbsolute, relative, resolve, sep } from "node:path";
import { Option, Schema } from "effect";

const ResourcePathSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (path) => isAbsolute(path) && !path.includes("\0") && resolve(path) === path,
      { description: "an absolute normalized file-system path without NUL bytes" },
    ),
  ),
  Schema.brand("ResourcePath"),
);
const decodeResourcePath = Schema.decodeUnknownOption(ResourcePathSchema);

/** Absolute normalized identity for a Pi-loaded resource. */
export type ResourcePath = typeof ResourcePathSchema.Type;

/**
 * Resolve a path against a working directory into an identity without dereferencing symlinks.
 * @throws If the resolved identity violates file-system path invariants.
 */
export function resourcePathId(path: string, cwd: string): ResourcePath {
  return ResourcePathSchema.make(resolve(cwd, path));
}

/** Parse a persisted path, which must already be absolute and usable as a file-system path. */
export function parseResourcePath(path: string): ResourcePath | undefined {
  return isAbsolute(path) ? Option.getOrUndefined(decodeResourcePath(resolve(path))) : undefined;
}

/** Whether a path is lexically inside a parent path or equal to it. */
export function pathIsInsideOrEqual(path: string, parent: string): boolean {
  const difference = relative(parent, path);
  return (
    difference === "" ||
    (difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
  );
}
