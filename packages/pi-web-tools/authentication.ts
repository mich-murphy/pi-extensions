import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Effect, Redacted } from "effect";
import { CredentialFailure } from "./credentials";
import type { CredentialResolver } from "./credentials";
import { BRAVE_API_KEY_ENV, EXA_API_KEY_ENV, PARALLEL_API_KEY_ENV } from "./settings";
import type { SearchProviderName } from "./types";

export const WEB_AUTH_PROVIDERS = {
  exa: { id: "pi-web-tools-exa", label: "Web Tools: Exa", env: EXA_API_KEY_ENV },
  parallel: {
    id: "pi-web-tools-parallel",
    label: "Web Tools: Parallel",
    env: PARALLEL_API_KEY_ENV,
  },
  brave: { id: "pi-web-tools-brave", label: "Web Tools: Brave", env: BRAVE_API_KEY_ENV },
} as const;

/** Only our native resolver can authoritatively distinguish absent from unsupported credentials. */
const ABSENT_SOURCE = "pi-web-tools:credential-absent";

function usable(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !value
      .trim()
      .split("")
      .some((character) => character < " " || character === "\u007f")
  );
}

/** Module instances share only globalThis; a subagent child loads its own instance. */
const ORIGINS = Symbol.for("pi-web-tools.native-auth-origins.v1");

function origins(): WeakMap<Provider, ModelRegistry> | undefined {
  const existing: unknown = Reflect.get(globalThis, ORIGINS);
  if (existing instanceof WeakMap) {
    return existing;
  }
  if (existing !== undefined) {
    return undefined;
  }
  const map = new WeakMap<Provider, ModelRegistry>();
  return Reflect.set(globalThis, ORIGINS, map) ? map : undefined;
}

function inherited(registry: ModelRegistry, id: string): boolean {
  const native = registry.getRegisteredNativeProvider(id);
  if (native === undefined) {
    return false;
  }
  const origin = origins()?.get(native);
  return origin !== undefined && origin !== registry;
}

function collides(
  registry: ModelRegistry,
  owned: Map<string, Provider> | undefined,
  id: string,
): boolean {
  if (owned === undefined) {
    return registry.getProvider(id) !== undefined && !inherited(registry, id);
  }
  return !owned.has(id) || registry.getRegisteredNativeProvider(id) !== owned.get(id);
}

/** Register from session_start only: the public registry must already be live. */
export function createWebAuthentication(): {
  readonly register: (pi: Pick<ExtensionAPI, "registerProvider">, registry: ModelRegistry) => void;
  readonly unregister: (
    pi: Pick<ExtensionAPI, "unregisterProvider">,
    registry: ModelRegistry,
  ) => void;
  readonly resolverFor: (registry: ModelRegistry) => CredentialResolver["Service"];
} {
  const ownership = new WeakMap<ModelRegistry, Map<string, Provider>>();
  return {
    register(pi, registry) {
      const owned = ownership.get(registry);
      // Preflight every id before making any changes, including repeat registrations.
      for (const metadata of Object.values(WEB_AUTH_PROVIDERS)) {
        if (collides(registry, owned, metadata.id)) {
          throw new Error("Web tools authentication provider collision");
        }
      }
      if (owned) {
        return;
      }
      const registrations = new Map<string, Provider>();
      ownership.set(registry, registrations);
      const providers: readonly SearchProviderName[] = ["exa", "parallel", "brave"];
      for (const provider of providers) {
        const metadata = WEB_AUTH_PROVIDERS[provider];
        pi.registerProvider(metadata.id, { models: [] });
        const generated = registry.getProvider(metadata.id);
        if (!generated?.auth.apiKey) {
          throw new Error("Web tools authentication registration unavailable");
        }
        const native: Provider = {
          ...generated,
          name: metadata.label,
          auth: {
            ...generated.auth,
            apiKey: {
              ...generated.auth.apiKey,
              name: metadata.label,
              // This check performs no credential resolution. Pi may already have
              // executed stored !commands before calling it. AuthStorage owns
              // command execution at read time (synchronous, ten-second timeout,
              // cached output including failures); our AbortSignal cannot interrupt it.
              check: async ({ credential, ctx, signal }) => {
                signal.throwIfAborted();
                if (credential) {
                  return { type: "api_key", source: "stored credential" };
                }
                const value = await ctx.env(metadata.env);
                signal.throwIfAborted();
                if (usable(value)) {
                  return { type: "api_key", source: metadata.env };
                }
                return undefined;
              },
              resolve: async ({ credential, ctx, signal }) => {
                signal.throwIfAborted();
                if (credential) {
                  if (!usable(credential.key)) {
                    throw new CredentialFailure({ provider, reason: "invalid" });
                  }
                  return { auth: { apiKey: credential.key.trim() }, source: "stored credential" };
                }
                const value = await ctx.env(metadata.env);
                signal.throwIfAborted();
                if (value === undefined || value.trim() === "") {
                  // Empty ModelAuth is public and valid for an auth-only provider. A marker
                  // avoids treating unsupported stored OAuth as absence when Pi's metadata
                  // snapshot is stale. check() still reports this provider as unconfigured.
                  return { auth: {}, source: ABSENT_SOURCE };
                }
                if (!usable(value)) {
                  throw new CredentialFailure({ provider, reason: "invalid" });
                }
                return { auth: { apiKey: value.trim() }, source: metadata.env };
              },
            },
          },
        };
        origins()?.set(native, registry);
        pi.registerProvider(native);
        registrations.set(metadata.id, native);
      }
    },
    unregister(pi, registry) {
      const owned = ownership.get(registry);
      if (owned === undefined) {
        return;
      }
      try {
        for (const [id, native] of owned) {
          if (registry.getRegisteredNativeProvider(id) === native) {
            pi.unregisterProvider(id);
          }
        }
      } finally {
        ownership.delete(registry);
      }
    },
    resolverFor(registry) {
      return {
        resolve: (provider) =>
          Effect.tryPromise({
            try: async (signal) => {
              signal.throwIfAborted();
              const { id } = WEB_AUTH_PROVIDERS[provider];
              const owned = ownership.get(registry)?.get(id);
              if (!owned || registry.getRegisteredNativeProvider(id) !== owned) {
                throw new CredentialFailure({ provider, reason: "incompatible" });
              }
              const result = await registry.getProviderAuth(id);
              signal.throwIfAborted();
              if (registry.getRegisteredNativeProvider(id) !== owned) {
                throw new CredentialFailure({ provider, reason: "incompatible" });
              }
              if (!result) {
                throw new CredentialFailure({ provider, reason: "incompatible" });
              }
              if (result.source === ABSENT_SOURCE && result.auth.apiKey === undefined) {
                return undefined;
              }
              const key = result.auth.apiKey;
              if (!usable(key)) {
                throw new CredentialFailure({ provider, reason: "invalid" });
              }
              return Redacted.make(key.trim());
            },
            // Pi auth exceptions can contain a command and its output. Never retain them.
            catch: (error) =>
              error instanceof CredentialFailure
                ? error
                : new CredentialFailure({ provider, reason: "resolution" }),
          }).pipe(
            Effect.timeoutOrElse({
              duration: "10 seconds",
              orElse: () => Effect.fail(new CredentialFailure({ provider, reason: "timeout" })),
            }),
          ),
      };
    },
  };
}
