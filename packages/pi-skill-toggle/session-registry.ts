/**
 * Process-wide registry of skill-toggle sessions, so subagents can follow their parent.
 *
 * Subagent extensions load every extension again for a child session, as a separate module
 * instance in the same process. `globalThis` is the only thing the instances share, so entries
 * are plain versioned objects of functions: no class identity, and every read is validated.
 */
import type { ToggleResource } from "./resources";

const REGISTRY = Symbol.for("pi-skill-toggle.sessions");

/** A resource a child session asks its parent about. */
export type SessionResource = {
  readonly id: string;
  readonly kind: ToggleResource["kind"];
  /** Skill name, or the instruction's path. */
  readonly name: string;
};

/** What a registered session decides for its children, evaluated live at every call. */
export type SessionPolicy = {
  readonly version: 1;
  /** Name the disabled resource an absolute path belongs to, or return undefined. */
  readonly match: (path: string) => string | undefined;
  /** Whether the session wants a resource visible, or undefined when it does not know it. */
  readonly desiredVisible: (resource: SessionResource) => boolean | undefined;
};

type Callable = (...args: readonly unknown[]) => unknown;

function isCallable(value: unknown): value is Callable {
  return typeof value === "function";
}

function sessions(create: boolean): Map<unknown, unknown> | undefined {
  const existing: unknown = Reflect.get(globalThis, REGISTRY);
  if (existing instanceof Map) {
    return existing;
  }
  if (existing !== undefined || !create) {
    return undefined;
  }
  const map = new Map<unknown, unknown>();
  return Reflect.set(globalThis, REGISTRY, map) ? map : undefined;
}

/** Register or refresh a session's policy. A malformed registry is left alone. */
export function registerSession(id: string, policy: SessionPolicy): void {
  try {
    sessions(true)?.set(id, policy);
  } catch {
    // Another module owns a broken registry; children fall back to their own state.
  }
}

/** Remove a session's policy, unless another instance has replaced it since. */
export function unregisterSession(id: string, policy: SessionPolicy): void {
  try {
    const map = sessions(false);
    if (map?.get(id) === policy) {
      map.delete(id);
    }
  } catch {
    // Nothing to remove from a broken registry.
  }
}

/**
 * Look up a registered session's policy.
 *
 * @returns A wrapper that never throws, or undefined when no valid version 1 entry exists.
 */
export function sessionPolicy(id: string): SessionPolicy | undefined {
  try {
    const entry: unknown = sessions(false)?.get(id);
    if (typeof entry !== "object" || entry === null) {
      return undefined;
    }
    const version: unknown = Reflect.get(entry, "version");
    const match: unknown = Reflect.get(entry, "match");
    const desiredVisible: unknown = Reflect.get(entry, "desiredVisible");
    return version === 1 && isCallable(match) && isCallable(desiredVisible)
      ? safePolicy(match, desiredVisible)
      : undefined;
  } catch {
    return undefined;
  }
}

function safePolicy(match: Callable, desiredVisible: Callable): SessionPolicy {
  return {
    version: 1,
    match: (path) => {
      try {
        const result = match(path);
        return typeof result === "string" ? result : undefined;
      } catch {
        // A parent that cannot decide blocks the path, like a state failure does.
        return path;
      }
    },
    desiredVisible: (resource) => {
      try {
        const result = desiredVisible(resource);
        return typeof result === "boolean" ? result : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
