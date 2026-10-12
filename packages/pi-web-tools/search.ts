import { randomUUID } from "node:crypto";
import { Context, Effect, Layer, Result, Schema } from "effect";
import type { Redacted } from "effect";
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
  | { readonly _tag: "KeylessMcp"; readonly endpoint: PublicHttpUrl };

function selectProviderRoute(
  apiKey: Redacted.Redacted | undefined,
  override: PublicHttpUrl | undefined,
  defaultEndpoint: PublicHttpUrl,
): ProviderRoute {
  return override === undefined && apiKey !== undefined
    ? { _tag: "OfficialApi", apiKey }
    : { _tag: "KeylessMcp", endpoint: override ?? defaultEndpoint };
}

const PROVIDER_BUILDERS: Record<
  SearchProviderName,
  (composition: ProviderComposition) => ProviderPair | undefined
> = {
  exa: ({ settings, http, mcpFor }) => {
    const route = selectProviderRoute(
      settings.credentials.exaApiKey,
      settings.endpoints.exa,
      EXA_MCP_DEFAULT_ENDPOINT,
    );
    if (route._tag === "OfficialApi") {
      return {
        search: new ExaApiSearchProvider(route.apiKey, http),
        fetch: new ExaApiFetchProvider(route.apiKey, http),
      };
    }
    const mcp = mcpFor(route.endpoint);
    return { search: new ExaMcpSearchProvider(mcp), fetch: new ExaMcpFetchProvider(mcp) };
  },
  parallel: ({ settings, http, sessionId, mcpFor }) => {
    const route = selectProviderRoute(
      settings.credentials.parallelApiKey,
      settings.endpoints.parallel,
      PARALLEL_MCP_DEFAULT_ENDPOINT,
    );
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
  brave: ({ settings, http }) => {
    const apiKey = settings.credentials.braveApiKey;
    return apiKey === undefined ? undefined : { search: new BraveApiSearchProvider(apiKey, http) };
  },
};

function buildProviderPairs(composition: ProviderComposition): ProviderPair[] {
  return composition.settings.search.providers.flatMap(
    (name) => PROVIDER_BUILDERS[name](composition) ?? [],
  );
}

/**
 * The configured provider pairs, built once per layer build. Both chains read this one service, so
 * they share its Parallel session id and its MCP clients (McpClients also caches per endpoint).
 */
class ProviderPairs extends Context.Service<ProviderPairs, readonly ProviderPair[]>()(
  "pi-web-tools/search/ProviderPairs",
) {
  static readonly layer = Layer.effect(
    ProviderPairs,
    Effect.gen(function* () {
      const settings = yield* WebToolsConfig;
      const http = yield* ProviderHttpClient;
      const mcpClients = yield* McpClients;
      return ProviderPairs.of(
        buildProviderPairs({
          settings,
          http,
          sessionId: randomUUID(),
          mcpFor: mcpClients.forEndpoint,
        }),
      );
    }),
  );
}

/** The ordered search provider chain from settings (see PROVIDER_BUILDERS for selection). */
export class SearchProviders extends Context.Service<SearchProviders, readonly SearchProvider[]>()(
  "pi-web-tools/search/SearchProviders",
) {
  /** Built from WebToolsConfig, ProviderHttpClient and McpClients; shares state with FetchRescueProviders. */
  static readonly layer: Layer.Layer<
    SearchProviders,
    never,
    WebToolsConfig | ProviderHttpClient | McpClients
  > = Layer.effect(
    SearchProviders,
    Effect.gen(function* () {
      const pairs = yield* ProviderPairs;
      return SearchProviders.of(pairs.map((pair) => pair.search));
    }),
  ).pipe(Layer.provide(ProviderPairs.layer));
}

/** The ordered fetch-rescue provider chain (search priority order, fetch-capable providers only). */
export class FetchRescueProviders extends Context.Service<
  FetchRescueProviders,
  readonly FetchProvider[]
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
      return FetchRescueProviders.of(pairs.flatMap((pair) => pair.fetch ?? []));
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
