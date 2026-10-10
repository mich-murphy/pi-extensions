import { Data, Effect, Result } from "effect";
import { McpHttpClient } from "./mcp";
import { BraveApiSearchProvider } from "./provider-brave";
import {
  ExaApiFetchProvider,
  ExaApiSearchProvider,
  ExaMcpFetchProvider,
  ExaMcpSearchProvider,
} from "./provider-exa";
import type { ProviderHttpClient } from "./provider-http";
import {
  ParallelApiSearchProvider,
  ParallelMcpFetchProvider,
  ParallelMcpSearchProvider,
} from "./provider-parallel";
import type { FetchProvider, SearchProvider } from "./provider-types";
import {
  EXA_MCP_DEFAULT_ENDPOINT,
  PARALLEL_MCP_DEFAULT_ENDPOINT,
  SEARCH_MAX_RESPONSE_BYTES,
  SEARCH_TIMEOUT_SECONDS,
} from "./settings";
import type { WebToolsSettings } from "./settings";
import type {
  NormalizedSearchResult,
  PublicHttpUrl,
  SearchProviderName,
  SearchQuery,
} from "./types";

/** Dependencies the composition root injects into provider construction. */
export type ProviderComposition = {
  readonly settings: WebToolsSettings;
  readonly http: ProviderHttpClient;
  readonly sessionId: string;
  readonly mcpFor: (endpoint: PublicHttpUrl) => McpHttpClient;
};

/** Create the default MCP client factory (keyless; keys are never attached to MCP endpoints). */
export function defaultMcpFor(endpoint: PublicHttpUrl): McpHttpClient {
  return new McpHttpClient(endpoint, {
    maxResponseBytes: SEARCH_MAX_RESPONSE_BYTES,
    timeoutMs: SEARCH_TIMEOUT_SECONDS.default * 1000,
  });
}

/** The search provider for one configured name, plus its fetch-rescue provider when it has one. */
type ProviderPair = {
  readonly search: SearchProvider;
  readonly fetch?: FetchProvider;
};

/**
 * How each configured provider name is built. Keyed providers use official
 * REST APIs; unkeyed Exa/Parallel use the official hosted MCP endpoints; an
 * endpoint override forces MCP to the override and never receives API keys.
 * A pair shares one MCP client between search and fetch, which is safe because
 * McpHttpClient opens a fresh session per tool call.
 */
const PROVIDER_BUILDERS: Record<
  SearchProviderName,
  (composition: ProviderComposition) => ProviderPair | undefined
> = {
  exa: ({ settings, http, mcpFor }) => {
    const apiKey = settings.credentials.exaApiKey;
    if (settings.endpoints.exa === undefined && apiKey !== undefined && apiKey !== "") {
      return {
        search: new ExaApiSearchProvider(apiKey, http),
        fetch: new ExaApiFetchProvider(apiKey, http),
      };
    }
    const mcp = mcpFor(settings.endpoints.exa ?? EXA_MCP_DEFAULT_ENDPOINT);
    return { search: new ExaMcpSearchProvider(mcp), fetch: new ExaMcpFetchProvider(mcp) };
  },
  parallel: ({ settings, http, sessionId, mcpFor }) => {
    const apiKey = settings.credentials.parallelApiKey;
    const mcp = mcpFor(settings.endpoints.parallel ?? PARALLEL_MCP_DEFAULT_ENDPOINT);
    return {
      search:
        settings.endpoints.parallel === undefined && apiKey !== undefined && apiKey !== ""
          ? new ParallelApiSearchProvider(apiKey, http)
          : new ParallelMcpSearchProvider(mcp, sessionId),
      // Parallel has no REST fetch provider, so the rescue path always uses MCP.
      fetch: new ParallelMcpFetchProvider(mcp, sessionId),
    };
  },
  brave: ({ settings, http }) => {
    // parseSettings guarantees the key when brave is in the provider list. Brave has no page fetch.
    const apiKey = settings.credentials.braveApiKey;
    return apiKey === undefined || apiKey === ""
      ? undefined
      : { search: new BraveApiSearchProvider(apiKey, http) };
  },
};

function buildProviderPairs(composition: ProviderComposition): ProviderPair[] {
  return composition.settings.search.providers.flatMap(
    (name) => PROVIDER_BUILDERS[name](composition) ?? [],
  );
}

/** Build the ordered search provider chain from settings (see PROVIDER_BUILDERS for selection). */
export function buildSearchProviders(composition: ProviderComposition): SearchProvider[] {
  return buildProviderPairs(composition).map((pair) => pair.search);
}

/** Build the ordered fetch-rescue provider chain (search priority order, fetch-capable providers only). */
export function buildFetchProviders(composition: ProviderComposition): FetchProvider[] {
  return buildProviderPairs(composition).flatMap((pair) => pair.fetch ?? []);
}

/** A successful search: the provider that answered plus its results. */
export type SearchChainSuccess = {
  readonly provider: SearchProviderName;
  readonly attemptedProviders: readonly SearchProviderName[];
  readonly results: readonly NormalizedSearchResult[];
};

/** The provider override names a provider that is not enabled. */
export class UnknownProvider extends Data.TaggedError("UnknownProvider")<{
  /** The requested provider name. */
  readonly provider: string;
  /** The enabled provider names. */
  readonly available: readonly string[];
}> {
  /** Safe user-facing description listing the enabled providers. */
  override get message(): string {
    return `Provider "${this.provider}" is not enabled. Available: ${this.available.join(", ")}`;
  }
}

/** Every provider in the chain failed. */
export class AllProvidersFailed extends Data.TaggedError("AllProvidersFailed")<{
  /** One safe "<provider>: <reason>" line per attempted provider. */
  readonly attempts: readonly string[];
}> {
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

function runChain(
  providers: readonly SearchProvider[],
  input: { readonly query: SearchQuery; readonly maxResults: number },
): Effect.Effect<SearchChainSuccess, AllProvidersFailed> {
  return Effect.gen(function* () {
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
}
