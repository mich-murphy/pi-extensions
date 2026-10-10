import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseResourcePath } from "./resource-path";
import type { ResourcePath } from "./resource-path";
import { isToggleValue } from "./resources";
import type { ToggleOverrides, ToggleValue } from "./resources";
import { err, ok } from "./result";
import type { Result } from "./result";

const STATE_VERSION = 6;
const RESET_ADVICE = "Fix the file, or remove it to reset all toggles.";

/** Plain-English reasons for the file-system failures users can act on. */
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
  readonly set: (id: ResourcePath, value: ToggleValue | "default") => ToggleStateResult;
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

  /** Change one override, keep the others, and drop entries whose file no longer exists. */
  set(id: ResourcePath, value: ToggleValue | "default"): ToggleStateResult {
    const stored = this.read("update");
    if (stored._tag === "err") {
      return stored;
    }
    return fileSystem("update", this.path, () => {
      const overrides = new Map(
        [...stored.value].filter(([path]) => statSync(path, { throwIfNoEntry: false })),
      );
      if (value === "default") {
        overrides.delete(id);
      } else {
        overrides.set(id, value);
      }
      this.write(overrides);
      return overrides;
    });
  }

  private read(operation: ToggleStateUnavailable["operation"]): ToggleStateResult {
    const content = fileSystem(operation, this.path, () => readFileSync(this.path, "utf8"));
    if (content._tag === "ok") {
      return parseState(this.path, content.value);
    }
    return content.error.code === "ENOENT" ? ok(new Map()) : content;
  }

  private write(overrides: ToggleOverrides): void {
    const entries = [...overrides].toSorted(([left], [right]) => left.localeCompare(right));
    const state = { version: STATE_VERSION, overrides: Object.fromEntries(entries) };
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
  if (state.version === STATE_VERSION) {
    return parseOverrides(path, state.overrides, (entry) => entry);
  }
  if (state.version > STATE_VERSION) {
    return err(new ToggleStateTooNew(path, state.version));
  }
  // Versions 4 and 5 stored `{ enabled }` beside metadata that is now derived from the path.
  if (state.version === 4 || state.version === 5) {
    return parseOverrides(path, state.resources, (entry) => {
      if (!isRecord(entry) || typeof entry.enabled !== "boolean") {
        return undefined;
      }
      return entry.enabled ? "enabled" : "disabled";
    });
  }
  // Versions before 4 identified resources by name, which cannot be mapped to a path.
  return state.version < 4 ? ok(new Map()) : err(new ToggleStateMalformed(path, undefined));
}

function parseOverrides(
  path: string,
  entries: unknown,
  toValue: (entry: unknown) => unknown,
): ToggleStateResult {
  if (!isRecord(entries)) {
    return err(new ToggleStateMalformed(path, undefined));
  }
  const overrides = new Map<ResourcePath, ToggleValue>();
  for (const [key, entry] of Object.entries(entries)) {
    const id = parseResourcePath(key);
    const value = toValue(entry);
    if (!(id && isToggleValue(value))) {
      return err(new ToggleStateMalformed(path, key));
    }
    overrides.set(id, value);
  }
  return ok(overrides);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
