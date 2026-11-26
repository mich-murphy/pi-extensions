import type { Credential, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Effect, Option, Redacted, Schema } from "effect";
import { CredentialFailure } from "./credentials";
import type { CredentialResolver } from "./credentials";
import { BRAVE_API_KEY_ENV, EXA_API_KEY_ENV, PARALLEL_API_KEY_ENV } from "./settings";
import type { SearchProviderName } from "./types";

export const WEB_AUTH_PROVIDERS = {
  exa: { id: "pi-web-exa", legacyId: "pi-web-tools-exa", label: "Web: Exa", env: EXA_API_KEY_ENV },
  parallel: {
    id: "pi-web-parallel",
    legacyId: "pi-web-tools-parallel",
    label: "Web: Parallel",
    env: PARALLEL_API_KEY_ENV,
  },
  brave: {
    id: "pi-web-brave",
    legacyId: "pi-web-tools-brave",
    label: "Web: Brave",
    env: BRAVE_API_KEY_ENV,
  },
} as const;

const ABSENT_SOURCE = "pi-web:credential-absent";

export type LegacyCredentialReader = (providerId: string) => Credential | undefined;

export function effectiveCredential(
  credential: Extract<Credential, { type: "api_key" }> | undefined,
  legacyId: string,
  readLegacy: LegacyCredentialReader,
): Extract<Credential, { type: "api_key" }> | undefined {
  if (credential !== undefined) {
    return credential;
  }

  const legacy = readLegacy(legacyId);

  if (legacy?.type !== "api_key" || !Schema.is(Schema.String)(legacy.key)) {
    return undefined;
  }

  const key = legacy.key.trim();

  return key.startsWith("!") || key.includes("$") ? undefined : { type: "api_key", key };
}

function usable(value: string | undefined): value is string {
  return (
    Schema.is(Schema.String)(value) &&
    value.trim() !== "" &&
    !value
      .trim()
      .split("")
      .some((character) => character < " " || character === "\u007f")
  );
}

const ORIGINS = Symbol.for("pi-web.native-auth-origins.v1");

const decodeOrigins = Schema.decodeUnknownOption(
  Schema.Struct({
    [ORIGINS]: Schema.optional(Schema.instanceOf(WeakMap<Provider, ModelRegistry>)),
  }),
);

function origins(): WeakMap<Provider, ModelRegistry> | undefined {
  const decoded = decodeOrigins(globalThis);

  if (Option.isNone(decoded)) {
    return undefined;
  }

  const existing = decoded.value[ORIGINS];

  if (existing !== undefined) {
    return existing;
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

export type WebAuthentication = {
  readonly register: (pi: Pick<ExtensionAPI, "registerProvider">, registry: ModelRegistry) => void;
  readonly unregister: (
    pi: Pick<ExtensionAPI, "unregisterProvider">,
    registry: ModelRegistry,
  ) => void;
  readonly resolverFor: (registry: ModelRegistry) => CredentialResolver["Service"];
};

export function createWebAuthentication(
  readLegacy: LegacyCredentialReader = () => undefined,
): WebAuthentication {
  const ownership = new WeakMap<ModelRegistry, Map<string, Provider>>();

  return {
    register(pi, registry) {
      const owned = ownership.get(registry);

      for (const metadata of Object.values(WEB_AUTH_PROVIDERS)) {
        if (collides(registry, owned, metadata.id)) {
          throw new Error("Web authentication provider collision");
        }
      }

      if (owned) {
        return;
      }

      const registrations = new Map<string, Provider>();
      ownership.set(registry, registrations);

      const providers = [
        "exa",
        "parallel",
        "brave",
      ] as const satisfies ReadonlyArray<SearchProviderName>;

      for (const provider of providers) {
        const metadata = WEB_AUTH_PROVIDERS[provider];
        pi.registerProvider(metadata.id, { models: [] });
        const generated = registry.getProvider(metadata.id);

        if (!generated?.auth.apiKey) {
          throw new Error("Web authentication registration unavailable");
        }

        const native: Provider = {
          ...generated,
          name: metadata.label,
          auth: {
            ...generated.auth,
            apiKey: {
              ...generated.auth.apiKey,
              name: metadata.label,
              check: async ({ credential: current, ctx, signal }) => {
                signal.throwIfAborted();
                const credential = effectiveCredential(current, metadata.legacyId, readLegacy);

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
              resolve: async ({ credential: current, ctx, signal }) => {
                signal.throwIfAborted();
                const credential = effectiveCredential(current, metadata.legacyId, readLegacy);

                if (credential) {
                  if (!usable(credential.key)) {
                    throw new CredentialFailure({ provider, reason: "invalid" });
                  }

                  return { auth: { apiKey: credential.key.trim() }, source: "stored credential" };
                }

                const value = await ctx.env(metadata.env);
                signal.throwIfAborted();

                if (value === undefined || value.trim() === "") {
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
            catch: (error) =>
              Schema.is(CredentialFailure)(error)
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
