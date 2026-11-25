import { Option, Predicate, Schema } from "effect";
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

const RegistryMap = Schema.instanceOf(Map<string, typeof Schema.Unknown.Type>);
const decodeRegistry = Schema.decodeUnknownOption(
  Schema.Struct({ [REGISTRY]: Schema.optional(RegistryMap) }),
);

type PolicyMatch = (path: string) => typeof Schema.Unknown.Type;
type PolicyVisibility = (resource: SessionResource) => typeof Schema.Unknown.Type;

const Policy = Schema.Struct({
  version: Schema.Literal(1),
  match: Schema.declare<PolicyMatch>((value): value is PolicyMatch => Predicate.isFunction(value)),
  desiredVisible: Schema.declare<PolicyVisibility>((value): value is PolicyVisibility =>
    Predicate.isFunction(value),
  ),
});
const decodePolicy = Schema.decodeUnknownOption(Policy);

type RegisteredPolicy = typeof Policy.Type;

function sessions(create: boolean): typeof RegistryMap.Type | undefined {
  const registry = decodeRegistry(globalThis);
  if (Option.isNone(registry)) {
    return undefined;
  }
  const existing = registry.value[REGISTRY];
  if (existing !== undefined || !create) {
    return existing;
  }
  const map = new Map<string, RegisteredPolicy>();
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
    const decoded = decodePolicy(sessions(false)?.get(id));
    return Option.isSome(decoded) ? safePolicy(decoded.value) : undefined;
  } catch {
    return undefined;
  }
}

function safePolicy({ match, desiredVisible }: RegisteredPolicy): SessionPolicy {
  return {
    version: 1,
    match: (path) => {
      try {
        const result = match(path);
        return Schema.is(Schema.String)(result) ? result : undefined;
      } catch {
        return path;
      }
    },
    desiredVisible: (resource) => {
      try {
        const result = desiredVisible(resource);
        return Schema.is(Schema.Boolean)(result) ? result : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
