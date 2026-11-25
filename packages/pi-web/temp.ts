import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Predicate, Schema } from "effect";

const FS_ERROR_DESCRIPTIONS = new Map(
  Object.entries({
    ENOSPC: "no space left on device",
    EDQUOT: "disk quota exceeded",
    EACCES: "permission denied",
    EPERM: "operation not permitted",
    EROFS: "read-only file system",
    ENOENT: "directory does not exist",
    ENOTDIR: "a path component is not a directory",
    EMFILE: "too many open files",
    ENFILE: "too many open files",
  }),
);

export class OutputStoreError extends Schema.TaggedError<OutputStoreError>()("OutputStoreError", {
  operation: Schema.Literals(["mkdtemp", "chmod", "write"]),
  path: Schema.String,
  code: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  get reason(): string {
    const description = FS_ERROR_DESCRIPTIONS.get(this.code);

    return description === undefined ? this.code : `${description} (${this.code})`;
  }

  override get message(): string {
    return `Could not save full output to ${this.path}: ${this.reason}`;
  }
}

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
