import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Data, Effect, Predicate } from "effect";

/** Plain-English descriptions of the filesystem error codes a temp-file write realistically hits. */
const FS_ERROR_DESCRIPTIONS: Readonly<Record<string, string>> = {
  ENOSPC: "no space left on device",
  EDQUOT: "disk quota exceeded",
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  EROFS: "read-only file system",
  ENOENT: "directory does not exist",
  ENOTDIR: "a path component is not a directory",
  EMFILE: "too many open files",
  ENFILE: "too many open files",
};

/** A filesystem operation failed while saving full tool output to a private temp file. */
export class OutputStoreError extends Data.TaggedError("OutputStoreError")<{
  /** The step that failed. */
  readonly operation: "mkdtemp" | "chmod" | "write";
  /** The directory template or file path the step was working on. */
  readonly path: string;
  /** The Node system error code, for example ENOSPC. */
  readonly code: string;
  /** The original Node error, kept for local diagnosis only. */
  readonly cause?: unknown;
}> {
  /** Plain-English reason with the error code, for example "no space left on device (ENOSPC)". */
  get reason(): string {
    const description = FS_ERROR_DESCRIPTIONS[this.code];
    return description === undefined ? this.code : `${description} (${this.code})`;
  }

  /** Safe description naming the path and the reason. */
  override get message(): string {
    return `Could not save full output to ${this.path}: ${this.reason}`;
  }
}

/**
 * Write tool output to a private temporary file.
 * The directory is created 0700 and the file 0600: fetched web content can
 * contain sensitive material and must not be world-readable in a shared tmpdir.
 * Node system errors (with `code` and `syscall`) become OutputStoreError; anything else is a
 * defect.
 */
export const writeTempTextFile = Effect.fnUntraced(function* (
  prefix: string,
  fileName: string,
  content: string,
): Effect.fn.Return<string, OutputStoreError> {
  const template = join(tmpdir(), prefix);
  const dir = yield* attempt("mkdtemp", template, async () => mkdtemp(template));
  yield* attempt("chmod", dir, async () => chmod(dir, 0o700));
  const outputPath = join(dir, fileName);
  yield* attempt("write", outputPath, async () =>
    writeFile(outputPath, content, { encoding: "utf8", mode: 0o600 }),
  );
  return outputPath;
});

function attempt<A>(
  operation: OutputStoreError["operation"],
  path: string,
  run: () => Promise<A>,
): Effect.Effect<A, OutputStoreError> {
  return Effect.tryPromise({ try: run, catch: (cause) => cause }).pipe(
    Effect.catch((cause) =>
      isNodeSystemError(cause)
        ? Effect.fail(new OutputStoreError({ operation, path, code: cause.code, cause }))
        : Effect.die(cause),
    ),
  );
}

/** Node system errors carry both a string `code` and the failing `syscall`. */
function isNodeSystemError(
  value: unknown,
): value is Error & { readonly code: string; readonly syscall: string } {
  return (
    value instanceof Error &&
    Predicate.hasProperty(value, "code") &&
    Predicate.isString(value.code) &&
    Predicate.hasProperty(value, "syscall") &&
    Predicate.isString(value.syscall)
  );
}
