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

export type ResourcePath = typeof ResourcePathSchema.Type;

export function resourcePathId(path: string, cwd: string): ResourcePath {
  return ResourcePathSchema.make(resolve(cwd, path));
}

export function parseResourcePath(path: string): ResourcePath | undefined {
  return isAbsolute(path) ? Option.getOrUndefined(decodeResourcePath(resolve(path))) : undefined;
}

export function pathIsInsideOrEqual(path: string, parent: string): boolean {
  const difference = relative(parent, path);

  return (
    difference === "" ||
    (difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
  );
}
