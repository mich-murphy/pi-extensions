import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseResourcePath, type ResourcePath } from "./resource-path";
import { isToggleValue, type ToggleOverrides, type ToggleValue } from "./resources";

const STATE_VERSION = 6;

/** Expected failure to read or replace the persisted state file. */
export class ToggleStateError extends Error {
  /** Stable error discriminator. */
  readonly _tag = "ToggleStateError" as const;

  /**
   * Create a classified state failure.
   *
   * @param operation - State operation that failed.
   * @param path - State file the operation targeted.
   * @param cause - Lower-level failure retained for local diagnosis.
   */
  constructor(
    readonly operation: "load" | "update",
    path: string,
    override readonly cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Could not ${operation} Pi skill-toggle state at ${path}: ${detail}`);
    this.name = "ToggleStateError";
  }
}

/** Overrides after a state operation, or the reason it failed. */
export type ToggleStateResult =
  | { readonly _tag: "ok"; readonly value: ToggleOverrides }
  | { readonly _tag: "err"; readonly error: ToggleStateError };

/** State operations required by the extension command and prompt handler. */
export interface ToggleStateStore {
  /** Read every persisted override without modifying the store. */
  load(): ToggleStateResult;

  /** Persist one resource's override, or clear it with `"default"`. */
  set(id: ResourcePath, value: ToggleValue | "default"): ToggleStateResult;
}

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
    return this.attempt("load", () => this.read());
  }

  /** Change one override, keep the others, and drop entries whose file no longer exists. */
  set(id: ResourcePath, value: ToggleValue | "default"): ToggleStateResult {
    return this.attempt("update", () => {
      const overrides = new Map(
        [...this.read()].filter(([path]) => statSync(path, { throwIfNoEntry: false })),
      );
      if (value === "default") overrides.delete(id);
      else overrides.set(id, value);
      this.write(overrides);
      return overrides;
    });
  }

  private attempt(
    operation: ToggleStateError["operation"],
    effect: () => ToggleOverrides,
  ): ToggleStateResult {
    try {
      return { _tag: "ok", value: effect() };
    } catch (cause) {
      return { _tag: "err", error: new ToggleStateError(operation, this.path, cause) };
    }
  }

  private read(): ToggleOverrides {
    let content: string;
    try {
      content = readFileSync(this.path, "utf8");
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return new Map();
      throw cause;
    }
    const overrides = parseState(content);
    if (!overrides) throw new Error("The file is malformed or unsupported. Fix or remove it.");
    return overrides;
  }

  private write(overrides: ToggleOverrides): void {
    const entries = [...overrides].sort(([left], [right]) => left.localeCompare(right));
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

function parseState(content: string): ToggleOverrides | undefined {
  let state: unknown;
  try {
    state = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(state) || typeof state.version !== "number") return undefined;
  if (state.version === STATE_VERSION) return parseOverrides(state.overrides, (entry) => entry);
  // Versions 4 and 5 stored `{ enabled }` beside metadata that is now derived from the path.
  if (state.version === 4 || state.version === 5) {
    return parseOverrides(state.resources, (entry) => {
      if (!isRecord(entry) || typeof entry.enabled !== "boolean") return undefined;
      return entry.enabled ? "enabled" : "disabled";
    });
  }
  // Versions before 4 identified resources by name, which cannot be mapped to a path.
  return state.version < 4 ? new Map() : undefined;
}

function parseOverrides(
  entries: unknown,
  toValue: (entry: unknown) => unknown,
): ToggleOverrides | undefined {
  if (!isRecord(entries)) return undefined;
  const overrides = new Map<ResourcePath, ToggleValue>();
  for (const [path, entry] of Object.entries(entries)) {
    const id = parseResourcePath(path);
    const value = toValue(entry);
    if (!(id && isToggleValue(value))) return undefined;
    overrides.set(id, value);
  }
  return overrides;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
