import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { diagnosticText } from "./diagnostic-text";
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
  EACCES: "permission denied. Check the file and folder permissions.",
  EPERM: "operation not permitted. Check the file and folder permissions.",
  ENOSPC: "the disk is full. Free some space and try again.",
  EDQUOT: "the disk quota is used up. Free some space and try again.",
  EROFS: "the file system is read-only. Use a writable agent directory.",
  EISDIR: "the path is a folder, not a file. Move the folder away.",
  ENOTDIR: "part of the path is a file, not a folder. Check the agent directory path.",
};

export class ToggleStateUnavailable extends Error {
  readonly _tag = "ToggleStateUnavailable" as const;

  constructor(
    readonly operation: "load" | "update",
    readonly path: string,
    readonly code: string,
    override readonly cause: unknown,
  ) {
    const reason =
      SYSTEM_ERROR_REASONS[code] ??
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

export type ToggleStateResult = Result<ToggleOverrides, ToggleStateError>;

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
    if (stored._tag === "err") {
      return stored;
    }
    return fileSystem("update", this.path, () => {
      const files = new Map(
        [...stored.value.files].filter(([path]) => resourceExistsOrIsUnverifiable(path)),
      );
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
    const current = readStateFile(operation, this.path);
    if (current !== undefined) {
      return current;
    }
    const legacy =
      this.legacyPath === undefined ? undefined : readStateFile(operation, this.legacyPath);
    return legacy ?? ok(emptyOverrides());
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
  if (content._tag === "ok") {
    return parseState(path, content.value);
  }
  return content.error.code === "ENOENT" ? undefined : content;
}

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

function migrateLegacyState(path: string, version: number, entries: unknown): ToggleStateResult {
  if (!isRecord(entries)) {
    return err(new ToggleStateMalformed(path, undefined));
  }
  const files = new Map<ResourcePath, ToggleValue>();
  const repositories = new Map<string, Map<string, ToggleValue>>();
  const locator = new RepositoryLocator();
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
