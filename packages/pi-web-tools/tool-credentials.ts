import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, Result } from "effect";
import { CredentialFailure, CredentialResolver } from "./credentials";
import type { CredentialSnapshot } from "./credentials";
import type { WebToolsSettings } from "./settings";
import { redactSecrets } from "./tool-output";
import type { SearchProviderName } from "./types";

/** Only the current execution's registry is retained while resolving credentials. */
export type ToolCredentialContext = Pick<ExtensionContext, "modelRegistry">;

/** Production binds Pi's resolver at execution time; test runtimes inject the same service. */
export type ToolCredentialComposition = {
  readonly credentialsForContext?: (
    context: ToolCredentialContext,
  ) => CredentialResolver["Service"];
};

/** Override the resolver for this program without changing the shared runtime or sibling calls. */
export function withToolCredentials<A, E, R>(
  program: Effect.Effect<A, E, R | CredentialResolver>,
  composition: ToolCredentialComposition,
  context: ToolCredentialContext | undefined,
): Effect.Effect<A, E, R | CredentialResolver> {
  return context !== undefined && composition.credentialsForContext !== undefined
    ? Effect.provideService(program, CredentialResolver, composition.credentialsForContext(context))
    : program;
}

/** Select relevant credentials without executing unused endpoint-override or disabled providers. */
export function credentialNames(
  settings: WebToolsSettings,
  options: {
    readonly providerOverride?: SearchProviderName;
    readonly fetchOnly?: boolean;
  } = {},
): readonly SearchProviderName[] {
  const candidates: readonly SearchProviderName[] = settings.search.defaultProviders
    ? [...settings.search.providers, "brave"]
    : settings.search.providers;
  return candidates.filter((name) => {
    if (options.providerOverride !== undefined && name !== options.providerOverride) {
      return false;
    }
    if (options.fetchOnly === true && name === "brave") {
      return false;
    }
    return name === "brave" || settings.endpoints[name] === undefined;
  });
}

/** An explicit Brave chain is invalid without a usable key, even if an earlier provider works. */
export function validateExplicitBrave(
  settings: WebToolsSettings,
  snapshot: CredentialSnapshot,
  providerOverride: SearchProviderName | undefined,
): Effect.Effect<void, CredentialFailure> {
  if (
    settings.search.defaultProviders ||
    !settings.search.providers.includes("brave") ||
    (providerOverride !== undefined && providerOverride !== "brave")
  ) {
    return Effect.void;
  }
  const outcome = snapshot.outcomes.brave;
  if (Result.isFailure(outcome)) {
    return Effect.fail(outcome.failure);
  }
  return outcome.success === undefined
    ? Effect.fail(new CredentialFailure({ provider: "brave", reason: "unavailable" }))
    : Effect.void;
}

/** The snapshot survives projection and outer error conversion, never shared between requests. */
export function createRequestRedactor(redactText: (input: string) => string) {
  let secrets: readonly string[] = [];
  return {
    capture: (snapshot: CredentialSnapshot): void => {
      secrets = snapshot.secrets;
    },
    redactText: (input: string): string => redactText(redactSecrets(input, secrets)),
  };
}
