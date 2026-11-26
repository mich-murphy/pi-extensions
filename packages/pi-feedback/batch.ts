import { dirname } from "node:path";
import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import type { ToolSource } from "./owner.ts";

const READ_ONLY_BUILTINS: ReadonlySet<string> = new Set(["read", "ls", "grep", "find"]);
const MISSING_PATH = /ENOENT|no such file|not found|does not exist|cannot find/iu;
const ABSOLUTE_PATH = /(?<![\w/~.])\/[^\s'"`,;:()[\]{}<>]+/gu;
const PATH_CHAR = /[^\s'"`,;:()[\]{}<>]/u;
const MIN_DIRECTORY_DEPTH = 2;

export type BatchCall = { readonly id: string; readonly name: string; readonly args: JsonObject };

export function isReadOnlyTool(tool: ToolSource | undefined): boolean {
  if (tool === undefined) {
    return false;
  }

  return (
    tool.annotations?.readOnlyHint === true ||
    (tool.sourceInfo.source === "builtin" && READ_ONLY_BUILTINS.has(tool.name))
  );
}

function stringsIn(value: JsonValue): Array<string> {
  if (typeof value === "string") {
    return [value];
  }

  return typeof value === "object" && value !== null
    ? Object.values<JsonValue>(value).flatMap((item) => stringsIn(item))
    : [];
}

function pathsIn(texts: ReadonlyArray<string>): Array<string> {
  return texts.flatMap((text) =>
    [...text.matchAll(ABSOLUTE_PATH)].map((match) => match[0].replace(/\.+$/u, "")),
  );
}

function mentions(text: string, path: string): boolean {
  for (let at = text.indexOf(path); at !== -1; at = text.indexOf(path, at + 1)) {
    const next = text[at + path.length];

    if (next === undefined || !PATH_CHAR.test(next)) {
      return true;
    }
  }

  return false;
}

function deepEnough(directory: string): boolean {
  return directory.split("/").filter((segment) => segment !== "").length >= MIN_DIRECTORY_DEPTH;
}

export function isParallelBatch(
  failing: BatchCall,
  error: string,
  batch: ReadonlyArray<BatchCall>,
  readOnly: (name: string) => boolean,
): boolean {
  if (!MISSING_PATH.test(error)) {
    return false;
  }

  const writers = batch.flatMap((call) =>
    call.id !== failing.id && !readOnly(call.name) ? [stringsIn(call.args).join("\n")] : [],
  );

  return pathsIn([error, ...stringsIn(failing.args)]).some((path) => {
    const directory = dirname(path);

    return writers.some(
      (text) => mentions(text, path) || (deepEnough(directory) && mentions(text, directory)),
    );
  });
}
