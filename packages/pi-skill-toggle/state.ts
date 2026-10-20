import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { RepositoryLocator } from "./repository";
import { parseResourcePath } from "./resource-path";
import type { ResourcePath } from "./resource-path";
import { emptyOverrides, isGlobalResourcePath, isToggleValue } from "./resources";
import type { ToggleOverrides, ToggleValue } from "./resources";
import { err, ok } from "./result";
import type { Result } from "./result";

const STATE_VERSION = 7;
const RESET_ADVICE = "Fix the file, or remove it to reset all toggles.";

const SYSTEM_ERROR_REASONS: Readonly<Record<string, string>> = {
  EACCES: "permission was denied. Check the permissions of the file and its folder.",
  EPERM: "the operation is not permitted. Check the permissions of the file and its folder.",
  ENOSPC: "the disk is full. Free some space and try again.",
  EDQUOT: "the disk quota is exhausted. Free some space and try again.",
  EROFS: "the file system is read-only.",
  EISDIR: "the path is a folder, not a file. Move the folder away.",
  ENOTDIR: "part of the path is a file, not a folder.",
};

/** The state file could not be read or replaced because the file system refused. */
export class ToggleStateUnavailable extends Error {
  /** Stable error discriminator. */
  readonly _tag = "ToggleStateUnavailable" as const;

  /**
   * Create a file-system failure.
   *
   * @param operation - State operation that failed.
   * @param path - State file the operation targeted.
   * @param code - Node system error code, such as `EACCES`.
   * @param cause - Original Node error, kept for local diagnosis only.
   */
  constructor(
    readonly operation: "load" | "update",
    readonly path: string,
    readonly code: string,
    override readonly cause: unknown,
  ) {
    const reason = SYSTEM_ERROR_REASONS[code] ?? `the file system reported ${code}.`;
    super(`Could not ${operation} Pi skill-toggle state at ${path}: ${reason}`, { cause });
    this.name = "ToggleStateUnavailable";
  }
}

/** The state file is not valid JSON. */
export class ToggleStateInvalidJson extends Error {
  /** Stable error discriminator. */
  readonly _tag = "ToggleStateInvalidJson" as const;

  /**
   * Create an invalid-JSON failure.
   *
   * @param path - State file that failed to parse.
   * @param cause - Parser error, kept for local diagnosis only.
   */
  constructor(
    readonly path: string,
    override readonly cause: unknown,
  ) {
    super(`Pi skill-toggle state at ${path} is not valid JSON. ${RESET_ADVICE}`, { cause });
    this.name = "ToggleStateInvalidJson";
  }
}

/** The state file was written by a newer release with a state version this one cannot read. */
export class ToggleStateTooNew extends Error {
  /** Stable error discriminator. */
  readonly _tag = "ToggleStateTooNew" as const;

  /**
   * Create a too-new failure.
   *
   * @param path - State file that holds the newer state.
   * @param version - Version recorded in the file.
   */
  constructor(
    readonly path: string,
    readonly version: number,
  ) {
    super(
      `Pi skill-toggle state at ${path} was written by a newer pi-skill-toggle (state version ${version}; this version reads up to ${STATE_VERSION}). Update pi-skill-toggle, or remove the file to reset all toggles.`,
    );
    this.name = "ToggleStateTooNew";
  }
}

/** The state file is JSON but does not have the expected structure. */
export class ToggleStateMalformed extends Error {
  /** Stable error discriminator. */
  readonly _tag = "ToggleStateMalformed" as const;

  /**
   * Create a malformed-state failure.
   *
   * @param path - State file with the bad content.
   * @param entry - Key of the offending entry, or undefined when the overall structure is wrong.
   */
  constructor(
    readonly path: string,
    readonly entry: string | undefined,
  ) {
    super(
      entry === undefined
        ? `Pi skill-toggle state at ${path} does not have the expected structure. ${RESET_ADVICE}`
        : `Pi skill-toggle state at ${path} has an invalid entry for ${entry}. Fix or remove that entry, or remove the file to reset all toggles.`,
    );
    this.name = "ToggleStateMalformed";
  }
}

/** Every expected failure of a state operation. */
export type ToggleStateError =
  | ToggleStateUnavailable
  | ToggleStateInvalidJson
  | ToggleStateTooNew
  | ToggleStateMalformed;

/** Overrides after a state operation, or the reason it failed. */
export type ToggleStateResult = Result<ToggleOverrides, ToggleStateError>;

/** State operations required by the extension command and prompt handler. */
export type ToggleStateStore = {
  /** Read every persisted override without modifying the store. */
  readonly load: () => ToggleStateResult;

  /** Persist one resource's override, or clear it with `"default"`. */
  readonly set: (
    id: ResourcePath,
    value: ToggleValue | "default",
    origin?: "global" | "project",
  ) => ToggleStateResult;
};

/**
 * Overrides persisted as one JSON file shared by every Pi session.
 *
 * Writes replace the file atomically, so loads never need a lock. Updates re-read the file
 * immediately before replacing it; the last of two simultaneous toggles wins.
 */
export class ToggleStateFile implements ToggleStateStore {
  /** Create a store at the supplied path, or in Pi's agent directory. */
  constructor(private readonly path = join(getAgentDir(), "pi-skill-toggle.json")) {}

  /** Read every persisted override. A missing file is an empty state. */
  load(): ToggleStateResult {
    return this.read("load");
  }

  /** Change one override, keep the others, and drop entries whose file is definitely missing. */
  set(
    id: ResourcePath,
    value: ToggleValue | "default",
    origin?: "global" | "project",
  ): ToggleStateResult {
    const stored = this.read("update");
    if (stored._tag === "err") {
      return stored;
    }
    return fileSystem("update", this.path, () => {
      const files = new Map(
        [...stored.value.files].filter(([path]) => resourceExistsOrIsUnverifiable(path)),
      );
      // Never prune repository policy based on one checkout's files or continued existence.
      const repositories = new Map(stored.value.repositories);
      const location =
        origin === "global" || isGlobalResourcePath(id)
          ? undefined
          : new RepositoryLocator().locate(id);
      if (location === undefined) {
        if (value === "default") {
          files.delete(id);
        } else {
          files.set(id, value);
        }
      } else {
        const entries = new Map(repositories.get(location.repository));
        if (value === "default") {
          entries.delete(location.path);
        } else {
          entries.set(location.path, value);
        }
        if (entries.size === 0) {
          repositories.delete(location.repository);
        } else {
          repositories.set(location.repository, entries);
        }
      }
      const overrides = { files, repositories };
      this.write(overrides);
      return overrides;
    });
  }

  private read(operation: ToggleStateUnavailable["operation"]): ToggleStateResult {
    const content = fileSystem(operation, this.path, () => readFileSync(this.path, "utf8"));
    if (content._tag === "ok") {
      return parseState(this.path, content.value);
    }
    return content.error.code === "ENOENT" ? ok(emptyOverrides()) : content;
  }

  private write(overrides: ToggleOverrides): void {
    const state = {
      version: STATE_VERSION,
      files: sorted(overrides.files),
      repositories: Object.fromEntries(
        [...overrides.repositories]
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([repository, entries]) => [repository, sorted(entries)]),
      ),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporaryPath, this.path);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
}

/**
 * Run synchronous file-system work, classifying only Node system errors.
 *
 * Node also gives argument errors (a `TypeError` with code `ERR_INVALID_ARG_VALUE`) a `code`;
 * only system errors carry `syscall`, so anything else is a defect and propagates.
 */
function fileSystem<A>(
  operation: ToggleStateUnavailable["operation"],
  path: string,
  run: () => A,
): Result<A, ToggleStateUnavailable> {
  try {
    return ok(run());
  } catch (cause) {
    if (cause instanceof Error && "syscall" in cause && "code" in cause) {
      return err(new ToggleStateUnavailable(operation, path, String(cause.code), cause));
    }
    throw cause;
  }
}

function resourceExistsOrIsUnverifiable(path: ResourcePath): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch (cause) {
    if (cause instanceof Error && "syscall" in cause && "code" in cause) {
      return cause.code !== "ENOENT" && cause.code !== "ENOTDIR";
    }
    throw cause;
  }
}

function parseState(path: string, content: string): ToggleStateResult {
  let state: unknown;
  try {
    state = JSON.parse(content);
  } catch (cause) {
    if (cause instanceof SyntaxError) {
      return err(new ToggleStateInvalidJson(path, cause));
    }
    throw cause;
  }
  if (!isRecord(state) || typeof state.version !== "number") {
    return err(new ToggleStateMalformed(path, undefined));
  }
  if (state.version > STATE_VERSION) {
    return err(new ToggleStateTooNew(path, state.version));
  }
  if (Number.isInteger(state.version) && state.version < 4) {
    return ok(emptyOverrides());
  }
  if (state.version === 7) {
    return parsePolicy(path, state);
  }
  if (state.version !== 4 && state.version !== 5 && state.version !== 6) {
    return err(new ToggleStateMalformed(path, undefined));
  }
  return migrateLegacyState(
    path,
    state.version,
    state.version === 6 ? state.overrides : state.resources,
  );
}

/** Convert old absolute choices into the shared policy without writing the state file. */
function migrateLegacyState(path: string, version: number, entries: unknown): ToggleStateResult {
  if (!isRecord(entries)) {
    return err(new ToggleStateMalformed(path, undefined));
  }
  const files = new Map<ResourcePath, ToggleValue>();
  const repositories = new Map<string, Map<string, ToggleValue>>();
  const locator = new RepositoryLocator();
  // Stable lexical order breaks child/child conflicts; a main checkout always wins.
  for (const [key, entry] of Object.entries(entries).toSorted(([a], [b]) => a.localeCompare(b))) {
    const id = parseResourcePath(key);
    const value = version === 6 ? entry : migrateEnabledResource(entry);
    if (!(id && isToggleValue(value))) {
      return err(new ToggleStateMalformed(path, key));
    }
    const location = isGlobalResourcePath(id) ? undefined : locator.locate(id);
    if (location === undefined) {
      files.set(id, value);
      continue;
    }
    const repository = repositories.get(location.repository) ?? new Map<string, ToggleValue>();
    if (location.main || !repository.has(location.path)) {
      repository.set(location.path, value);
    }
    repositories.set(location.repository, repository);
  }
  return ok({ files, repositories });
}

function migrateEnabledResource(entry: unknown): ToggleValue | undefined {
  if (!isRecord(entry) || typeof entry.enabled !== "boolean") {
    return undefined;
  }
  return entry.enabled ? "enabled" : "disabled";
}

function parsePolicy(path: string, state: Record<string, unknown>): ToggleStateResult {
  const files = parseFileOverrides(path, state.files);
  if (files._tag === "err") {
    return files;
  }
  const repositories = parseRepositoryOverrides(path, state.repositories);
  if (repositories._tag === "err") {
    return repositories;
  }
  return ok({ files: files.value, repositories: repositories.value });
}

function parseFileOverrides(
  path: string,
  entries: unknown,
): Result<Map<ResourcePath, ToggleValue>, ToggleStateMalformed> {
  if (!isRecord(entries)) {
    return err(new ToggleStateMalformed(path, undefined));
  }
  const files = new Map<ResourcePath, ToggleValue>();
  for (const [key, value] of Object.entries(entries)) {
    const id = parseResourcePath(key);
    // Two spellings of one path (such as a trailing slash) would otherwise silently drop one.
    if (!(id && isToggleValue(value)) || files.has(id)) {
      return err(new ToggleStateMalformed(path, key));
    }
    files.set(id, value);
  }
  return ok(files);
}

function parseRepositoryOverrides(
  path: string,
  entries: unknown,
): Result<Map<string, Map<string, ToggleValue>>, ToggleStateMalformed> {
  if (!isRecord(entries)) {
    return err(new ToggleStateMalformed(path, undefined));
  }
  const repositories = new Map<string, Map<string, ToggleValue>>();
  for (const [repository, resources] of Object.entries(entries)) {
    const id = parseResourcePath(repository);
    // Two spellings of one repository would otherwise silently drop one policy.
    if (!id || !isRecord(resources) || repositories.has(id)) {
      return err(new ToggleStateMalformed(path, repository));
    }
    const parsed = parseRelativeOverrides(path, resources);
    if (parsed._tag === "err") {
      return parsed;
    }
    repositories.set(id, parsed.value);
  }
  return ok(repositories);
}

function parseRelativeOverrides(
  path: string,
  entries: Record<string, unknown>,
): Result<Map<string, ToggleValue>, ToggleStateMalformed> {
  const resources = new Map<string, ToggleValue>();
  for (const [key, value] of Object.entries(entries)) {
    // A trailing slash names the same repository path as its bare spelling.
    const relativePath = key.replace(/\/+$/u, "");
    if (!validRelativePath(relativePath) || !isToggleValue(value) || resources.has(relativePath)) {
      return err(new ToggleStateMalformed(path, key));
    }
    resources.set(relativePath, value);
  }
  return ok(resources);
}

function validRelativePath(path: string): boolean {
  return (
    path !== "" &&
    path !== "." &&
    !isAbsolute(path) &&
    !path.includes("\0") &&
    normalize(path) === path &&
    path !== ".." &&
    !path.startsWith("../")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const sorted = (entries: ReadonlyMap<string, ToggleValue>): Record<string, ToggleValue> =>
  Object.fromEntries([...entries].toSorted(([left], [right]) => left.localeCompare(right)));
