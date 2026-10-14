import { randomUUID } from "node:crypto";
import { Context, Effect, Layer, Result, Schema } from "effect";
import type { Redacted } from "effect";
import { CredentialFailure } from "./credentials";
import type { CredentialSnapshot } from "./credentials";
import { McpClients } from "./mcp";
import type { McpClient } from "./mcp";
import { BraveApiSearchProvider } from "./provider-brave";
import {
  ExaApiFetchProvider,
  ExaApiSearchProvider,
  ExaMcpFetchProvider,
  ExaMcpSearchProvider,
} from "./provider-exa";
import { ProviderHttpClient } from "./provider-http";
import {
  ParallelApiSearchProvider,
  ParallelMcpFetchProvider,
  ParallelMcpSearchProvider,
} from "./provider-parallel";
import type { FetchProvider, SearchProvider } from "./provider-types";
import {
  EXA_MCP_DEFAULT_ENDPOINT,
  PARALLEL_MCP_DEFAULT_ENDPOINT,
  WebToolsConfig,
} from "./settings";
import type { WebToolsSettings } from "./settings";
import type {
  NormalizedSearchResult,
  PublicHttpUrl,
  SearchProviderName,
  SearchQuery,
} from "./types";

type ProviderComposition = {
  readonly settings: WebToolsSettings;
  readonly snapshot: CredentialSnapshot;
  readonly http: ProviderHttpClient["Service"];
  readonly sessionId: string;
  readonly mcpFor: (endpoint: PublicHttpUrl) => McpClient;
};

type ProviderPair = {
  readonly search: SearchProvider;
  readonly fetch?: FetchProvider;
};

type ProviderRoute =
  | { readonly _tag: "OfficialApi"; readonly apiKey: Redacted.Redacted }
  | { readonly _tag: "KeylessMcp"; readonly endpoint: PublicHttpUrl }
  | { readonly _tag: "Failed"; readonly error: CredentialFailure };

function selectProviderRoute(
  outcome: CredentialSnapshot["outcomes"][SearchProviderName],
  override: PublicHttpUrl | undefined,
  defaultEndpoint: PublicHttpUrl,
): ProviderRoute {
  if (override !== undefined) {
    return { _tag: "KeylessMcp", endpoint: override };
  }
  if (Result.isFailure(outcome)) {
    return { _tag: "Failed", error: outcome.failure };
  }
  return outcome.success === undefined
    ? { _tag: "KeylessMcp", endpoint: defaultEndpoint }
    : { _tag: "OfficialApi", apiKey: outcome.success };
}

function failedPair(name: SearchProviderName, error: CredentialFailure): ProviderPair {
  return { search: { name, transport: "api", search: () => Effect.fail(error) } };
}

const PROVIDER_BUILDERS: Record<
  SearchProviderName,
  (composition: ProviderComposition) => ProviderPair
> = {
  exa: ({ settings, snapshot, http, mcpFor }) => {
    const route = selectProviderRoute(
      snapshot.outcomes.exa,
      settings.endpoints.exa,
      EXA_MCP_DEFAULT_ENDPOINT,
    );
    if (route._tag === "Failed") {
      return failedPair("exa", route.error);
    }
    if (route._tag === "OfficialApi") {
      return {
        search: new ExaApiSearchProvider(route.apiKey, http),
        fetch: new ExaApiFetchProvider(route.apiKey, http),
      };
    }
    const mcp = mcpFor(route.endpoint);
    return { search: new ExaMcpSearchProvider(mcp), fetch: new ExaMcpFetchProvider(mcp) };
  },
  parallel: ({ settings, snapshot, http, sessionId, mcpFor }) => {
    const route = selectProviderRoute(
      snapshot.outcomes.parallel,
      settings.endpoints.parallel,
      PARALLEL_MCP_DEFAULT_ENDPOINT,
    );
    if (route._tag === "Failed") {
      return failedPair("parallel", route.error);
    }
    const mcp = mcpFor(
      route._tag === "KeylessMcp" ? route.endpoint : PARALLEL_MCP_DEFAULT_ENDPOINT,
    );
    return {
      search:
        route._tag === "OfficialApi"
          ? new ParallelApiSearchProvider(route.apiKey, http)
          : new ParallelMcpSearchProvider(mcp, sessionId),
      fetch: new ParallelMcpFetchProvider(mcp, sessionId),
    };
  },
  brave: ({ snapshot, http }) => {
    const outcome = snapshot.outcomes.brave;
    if (Result.isFailure(outcome)) {
      return failedPair("brave", outcome.failure);
    }
    return outcome.success === undefined
      ? failedPair("brave", new CredentialFailure({ provider: "brave", reason: "unavailable" }))
      : { search: new BraveApiSearchProvider(outcome.success, http) };
  },
};

function buildProviderPairs(composition: ProviderComposition): readonly ProviderPair[] {
  const { settings, snapshot } = composition;
  const brave = snapshot.outcomes.brave;
  const providers =
    settings.search.defaultProviders && (Result.isFailure(brave) || brave.success !== undefined)
      ? [...settings.search.providers, "brave" as const]
      : settings.search.providers;
  return providers.map((name) => PROVIDER_BUILDERS[name](composition));
}

/** Shared runtime composition; request adapters retain its clients and Parallel session identity. */
class ProviderPairs extends Context.Service<
  ProviderPairs,
  {
    readonly forRequest: (snapshot: CredentialSnapshot) => readonly ProviderPair[];
  }
>()("pi-web-tools/search/ProviderPairs") {
  static readonly layer = Layer.effect(
    ProviderPairs,
    Effect.gen(function* () {
      const settings = yield* WebToolsConfig;
      const http = yield* ProviderHttpClient;
      const mcpClients = yield* McpClients;
      const composition = {
        settings,
        http,
        sessionId: randomUUID(),
        mcpFor: mcpClients.forEndpoint,
      };
      return ProviderPairs.of({
        forRequest: (snapshot) =>
          buildProviderPairs({
            ...composition,
            snapshot,
            mcpFor: (endpoint) => {
              const cached = composition.mcpFor(endpoint);
              return { callTool: (name, args) => cached.callTool(name, args, snapshot.secrets) };
            },
          }),
      });
    }),
  );
}

/** The ordered search provider chain from settings (see PROVIDER_BUILDERS for selection). */
export class SearchProviders extends Context.Service<
  SearchProviders,
  {
    readonly forRequest: (snapshot: CredentialSnapshot) => readonly SearchProvider[];
  }
>()("pi-web-tools/search/SearchProviders") {
  /** Built from WebToolsConfig, ProviderHttpClient and McpClients; shares state with FetchRescueProviders. */
  static readonly layer: Layer.Layer<
    SearchProviders,
    never,
    WebToolsConfig | ProviderHttpClient | McpClients
  > = Layer.effect(
    SearchProviders,
    Effect.gen(function* () {
      const pairs = yield* ProviderPairs;
      return SearchProviders.of({
        forRequest: (snapshot) => pairs.forRequest(snapshot).map((pair) => pair.search),
      });
    }),
  ).pipe(Layer.provide(ProviderPairs.layer));
}

/** The ordered fetch-rescue provider chain (search priority order, fetch-capable providers only). */
export class FetchRescueProviders extends Context.Service<
  FetchRescueProviders,
  { readonly forRequest: (snapshot: CredentialSnapshot) => readonly FetchProvider[] }
>()("pi-web-tools/search/FetchRescueProviders") {
  /** Built from WebToolsConfig, ProviderHttpClient and McpClients; shares state with SearchProviders. */
  static readonly layer: Layer.Layer<
    FetchRescueProviders,
    never,
    WebToolsConfig | ProviderHttpClient | McpClients
  > = Layer.effect(
    FetchRescueProviders,
    Effect.gen(function* () {
      const pairs = yield* ProviderPairs;
      return FetchRescueProviders.of({
        forRequest: (snapshot) => pairs.forRequest(snapshot).flatMap((pair) => pair.fetch ?? []),
      });
    }),
  ).pipe(Layer.provide(ProviderPairs.layer));
}

/** A successful search: the provider that answered plus its results. */
export type SearchChainSuccess = {
  readonly provider: SearchProviderName;
  readonly attemptedProviders: readonly SearchProviderName[];
  readonly results: readonly NormalizedSearchResult[];
};

/** The provider override names a provider that is not enabled. */
export class UnknownProvider extends Schema.TaggedError<UnknownProvider>()("UnknownProvider", {
  /** The requested provider name. */
  provider: Schema.String,
  /** The enabled provider names. */
  available: Schema.Array(Schema.String),
}) {
  /** Safe user-facing description listing the enabled providers. */
  override get message(): string {
    return `Provider "${this.provider}" is not enabled. Available: ${this.available.join(", ")}`;
  }
}

/** Every provider in the chain failed. */
export class AllProvidersFailed extends Schema.TaggedError<AllProvidersFailed>()(
  "AllProvidersFailed",
  {
    /** One safe "<provider>: <reason>" line per attempted provider. */
    attempts: Schema.Array(Schema.String),
  },
) {
  /** Safe user-facing description joining each provider's reason. */
  override get message(): string {
    return `All search providers failed (${this.attempts.join("; ")})`;
  }
}

/** Expected failures of the search chain. */
export type SearchChainError = UnknownProvider | AllProvidersFailed;

/**
 * Run the provider chain in priority order, falling through on provider failures. A provider
 * failure becomes one "<provider>: <reason>" line; interruption stops the chain at once.
 */
export function searchWithFallback(
  providers: readonly SearchProvider[],
  input: { readonly query: SearchQuery; readonly maxResults: number },
  options: { readonly providerOverride?: SearchProviderName | undefined } = {},
): Effect.Effect<SearchChainSuccess, SearchChainError> {
  const { providerOverride } = options;
  if (providerOverride === undefined) {
    return runChain(providers, input);
  }
  const selected = providers.filter((provider) => provider.name === providerOverride);
  if (selected.length === 0) {
    return Effect.fail(
      new UnknownProvider({
        provider: providerOverride,
        available: providers.map((provider) => provider.name),
      }),
    );
  }
  return runChain(selected, input);
}

const runChain = Effect.fnUntraced(function* (
  providers: readonly SearchProvider[],
  input: { readonly query: SearchQuery; readonly maxResults: number },
): Effect.fn.Return<SearchChainSuccess, AllProvidersFailed> {
  const failures: string[] = [];
  const attempted: SearchProviderName[] = [];
  for (const provider of providers) {
    attempted.push(provider.name);
    const result = yield* Effect.result(provider.search(input));
    if (Result.isSuccess(result)) {
      return { provider: provider.name, attemptedProviders: attempted, results: result.success };
    }
    failures.push(`${provider.name}: ${result.failure.message}`);
  }
  return yield* new AllProvidersFailed({ attempts: failures });
});
