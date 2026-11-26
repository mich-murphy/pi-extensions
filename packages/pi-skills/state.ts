import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Predicate, Result, Schema } from "effect";
import { errnoCode } from "../shared/errno";
import { diagnosticText } from "./diagnostic-text";
import { RepositoryLocator } from "./repository";
import { parseResourcePath } from "./resource-path";
import type { ResourcePath } from "./resource-path";
import { emptyOverrides, isGlobalResourcePath, isToggleValue } from "./resources";
import type { ToggleOverrides, ToggleValue } from "./resources";

const STATE_VERSION = 7;
const RESET_ADVICE = "Fix the file, or remove it to reset all toggles.";

const SYSTEM_ERROR_REASONS = new Map(
  Object.entries({
    EACCES: "permission denied. Check the file and folder permissions.",
    EPERM: "operation not permitted. Check the file and folder permissions.",
    ENOSPC: "the disk is full. Free some space and try again.",
    EDQUOT: "the disk quota is used up. Free some space and try again.",
    EROFS: "the file system is read-only. Use a writable agent directory.",
    EISDIR: "the path is a folder, not a file. Move the folder away.",
    ENOTDIR: "part of the path is a file, not a folder. Check the agent directory path.",
  }),
);

export class ToggleStateUnavailable extends Error {
  readonly _tag = "ToggleStateUnavailable" as const;

  constructor(
    readonly operation: "load" | "update",
    readonly path: string,
    readonly code: string,
    override readonly cause: unknown,
  ) {
    const reason =
      SYSTEM_ERROR_REASONS.get(code) ??
      `the file system reported ${diagnosticText(code)}. Check the file, its folder permissions and free disk space.`;

    super(`Could not ${operation} pi-skills state at ${diagnosticText(path)}: ${reason}`, {
      cause,
    });
    this.name = "ToggleStateUnavailable";
  }
}

export class ToggleStateInvalidJson extends Error {
  readonly _tag = "ToggleStateInvalidJson" as const;

  constructor(
    readonly path: string,
    override readonly cause: unknown,
  ) {
    super(`pi-skills state at ${diagnosticText(path)} is not valid JSON. ${RESET_ADVICE}`, {
      cause,
    });
    this.name = "ToggleStateInvalidJson";
  }
}

export class ToggleStateTooNew extends Error {
  readonly _tag = "ToggleStateTooNew" as const;

  constructor(
    readonly path: string,
    readonly version: number,
  ) {
    super(
      `pi-skills state at ${diagnosticText(path)} is from a newer pi-skills (version ${version}; this reads up to ${STATE_VERSION}). Update pi-skills, or remove the file to reset toggles.`,
    );
    this.name = "ToggleStateTooNew";
  }
}

export class ToggleStateMalformed extends Error {
  readonly _tag = "ToggleStateMalformed" as const;

  constructor(
    readonly path: string,
    readonly entry: string | undefined,
  ) {
    super(
      entry === undefined
        ? `pi-skills state at ${diagnosticText(path)} does not have the expected structure. ${RESET_ADVICE}`
        : `pi-skills state at ${diagnosticText(path)} has an invalid entry for ${diagnosticText(entry)}. Fix or remove that entry, or remove the file to reset all toggles.`,
    );
    this.name = "ToggleStateMalformed";
  }
}

export type ToggleStateError =
  | ToggleStateUnavailable
  | ToggleStateInvalidJson
  | ToggleStateTooNew
  | ToggleStateMalformed;

export type ToggleStateResult = Result.Result<ToggleOverrides, ToggleStateError>;

export type ToggleStateStore = {
  readonly load: () => ToggleStateResult;

  readonly set: (
    id: ResourcePath,
    value: ToggleValue | "default",
    origin?: "global" | "project",
  ) => ToggleStateResult;
};

export class ToggleStateFile implements ToggleStateStore {
  constructor(
    private readonly path = join(getAgentDir(), "pi-skills.json"),
    private readonly legacyPath: string | undefined = join(dirname(path), "pi-skill-toggle.json"),
  ) {}

  load(): ToggleStateResult {
    return this.read("load");
  }

  set(
    id: ResourcePath,
    value: ToggleValue | "default",
    origin?: "global" | "project",
  ): ToggleStateResult {
    const stored = this.read("update");

    if (Result.isFailure(stored)) {
      return stored;
    }

    return fileSystem("update", this.path, () => {
      const files = new Map(
        [...stored.success.files].filter(([path]) => resourceExistsOrIsUnverifiable(path)),
      );

      const repositories = new Map(stored.success.repositories);

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
    const current = readStateFile(operation, this.path);

    if (current !== undefined) {
      return current;
    }

    const legacy =
      this.legacyPath === undefined ? undefined : readStateFile(operation, this.legacyPath);

    return legacy ?? Result.succeed(emptyOverrides());
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

function readStateFile(
  operation: ToggleStateUnavailable["operation"],
  path: string,
): ToggleStateResult | undefined {
  const content = fileSystem(operation, path, () => readFileSync(path, "utf8"));

  if (Result.isSuccess(content)) {
    return parseState(path, content.success);
  }

  return content.failure.code === "ENOENT" ? undefined : Result.fail(content.failure);
}

function fileSystem<A>(
  operation: ToggleStateUnavailable["operation"],
  path: string,
  run: () => A,
): Result.Result<A, ToggleStateUnavailable> {
  try {
    return Result.succeed(run());
  } catch (error) {
    const code = errnoCode(error);

    if (code !== undefined && Predicate.hasProperty(error, "syscall")) {
      return Result.fail(new ToggleStateUnavailable(operation, path, code, error));
    }

    throw error;
  }
}

function resourceExistsOrIsUnverifiable(path: ResourcePath): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch (error) {
    const code = errnoCode(error);

    if (code !== undefined && Predicate.hasProperty(error, "syscall")) {
      return code !== "ENOENT" && code !== "ENOTDIR";
    }

    throw error;
  }
}

function parseState(path: string, content: string): ToggleStateResult {
  let state: unknown;

  try {
    state = JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Result.fail(new ToggleStateInvalidJson(path, error));
    }

    throw error;
  }

  if (!isStateDocument(state)) {
    return Result.fail(new ToggleStateMalformed(path, undefined));
  }

  if (state.version > STATE_VERSION) {
    return Result.fail(new ToggleStateTooNew(path, state.version));
  }

  if (Number.isInteger(state.version) && state.version < 4) {
    return Result.succeed(emptyOverrides());
  }

  if (state.version === 7) {
    return parsePolicy(path, state);
  }

  if (state.version !== 4 && state.version !== 5 && state.version !== 6) {
    return Result.fail(new ToggleStateMalformed(path, undefined));
  }

  return migrateLegacyState(
    path,
    state.version,
    state.version === 6 ? state.overrides : state.resources,
  );
}

function migrateLegacyState(
  path: string,
  version: number,
  entries: StateValue | undefined,
): ToggleStateResult {
  if (!isStateRecord(entries)) {
    return Result.fail(new ToggleStateMalformed(path, undefined));
  }

  const files = new Map<ResourcePath, ToggleValue>();
  const repositories = new Map<string, Map<string, ToggleValue>>();
  const locator = new RepositoryLocator();

  for (const [key, entry] of Object.entries(entries).toSorted(([a], [b]) => a.localeCompare(b))) {
    const id = parseResourcePath(key);
    const value = version === 6 ? entry : migrateEnabledResource(entry);

    if (!(id && isToggleValue(value))) {
      return Result.fail(new ToggleStateMalformed(path, key));
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

  return Result.succeed({ files, repositories });
}

function migrateEnabledResource(entry: StateValue): ToggleValue | undefined {
  if (!isStateRecord(entry) || typeof entry.enabled !== "boolean") {
    return undefined;
  }

  return entry.enabled ? "enabled" : "disabled";
}

function parsePolicy(path: string, state: StateRecord): ToggleStateResult {
  const files = parseFileOverrides(path, state.files);

  if (Result.isFailure(files)) {
    return Result.fail(files.failure);
  }

  const repositories = parseRepositoryOverrides(path, state.repositories);

  if (Result.isFailure(repositories)) {
    return Result.fail(repositories.failure);
  }

  return Result.succeed({ files: files.success, repositories: repositories.success });
}

function parseFileOverrides(
  path: string,
  entries: StateValue | undefined,
): Result.Result<Map<ResourcePath, ToggleValue>, ToggleStateMalformed> {
  if (!isStateRecord(entries)) {
    return Result.fail(new ToggleStateMalformed(path, undefined));
  }

  const files = new Map<ResourcePath, ToggleValue>();

  for (const [key, value] of Object.entries(entries)) {
    const id = parseResourcePath(key);

    if (!(id && isToggleValue(value)) || files.has(id)) {
      return Result.fail(new ToggleStateMalformed(path, key));
    }

    files.set(id, value);
  }

  return Result.succeed(files);
}

function parseRepositoryOverrides(
  path: string,
  entries: StateValue | undefined,
): Result.Result<Map<string, Map<string, ToggleValue>>, ToggleStateMalformed> {
  if (!isStateRecord(entries)) {
    return Result.fail(new ToggleStateMalformed(path, undefined));
  }

  const repositories = new Map<string, Map<string, ToggleValue>>();

  for (const [repository, resources] of Object.entries(entries)) {
    const id = parseResourcePath(repository);

    if (!id || !isStateRecord(resources) || repositories.has(id)) {
      return Result.fail(new ToggleStateMalformed(path, repository));
    }

    const parsed = parseRelativeOverrides(path, resources);

    if (Result.isFailure(parsed)) {
      return Result.fail(parsed.failure);
    }

    repositories.set(id, parsed.success);
  }

  return Result.succeed(repositories);
}

function parseRelativeOverrides(
  path: string,
  entries: StateRecord,
): Result.Result<Map<string, ToggleValue>, ToggleStateMalformed> {
  const resources = new Map<string, ToggleValue>();

  for (const [key, value] of Object.entries(entries)) {
    const relativePath = key.replace(/\/+$/u, "");

    if (!validRelativePath(relativePath) || !isToggleValue(value) || resources.has(relativePath)) {
      return Result.fail(new ToggleStateMalformed(path, key));
    }

    resources.set(relativePath, value);
  }

  return Result.succeed(resources);
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

type StateRecord = typeof Schema.JsonObject.Type;

type StateValue = typeof Schema.Json.Type;

const StateValue: Schema.Codec<StateValue> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Number,
    Schema.String,
    Schema.Array(StateValue),
    Schema.Record(Schema.String, StateValue),
  ]),
);

const isStateDocument = Schema.is(
  Schema.StructWithRest(Schema.Struct({ version: Schema.Number }), [
    Schema.Record(Schema.String, StateValue),
  ]),
);

const isJsonReference = Schema.is(Schema.ObjectKeyword);

function isStateRecord(value: StateValue | undefined): value is StateRecord {
  return isJsonReference(value) && !Array.isArray(value);
}

const sorted = (entries: ReadonlyMap<string, ToggleValue>): Record<string, ToggleValue> =>
  Object.fromEntries([...entries].toSorted(([left], [right]) => left.localeCompare(right)));
