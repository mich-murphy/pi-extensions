import type { ToggleResource } from "./resources";

const REGISTRY = Symbol.for("pi-skills.sessions");

export type SessionResource = {
  readonly id: string;
  readonly kind: ToggleResource["kind"];
  readonly name: string;
};

export type SessionPolicy = {
  readonly version: 1;
  readonly match: (path: string) => string | undefined;
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

export function registerSession(id: string, policy: SessionPolicy): boolean {
  try {
    return sessions(true)?.set(id, policy) !== undefined;
  } catch {
    return false;
  }
}

export function unregisterSession(id: string, policy: SessionPolicy): boolean {
  try {
    const map = sessions(false);
    return map?.get(id) === policy && map.delete(id);
  } catch {
    return false;
  }
}

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
