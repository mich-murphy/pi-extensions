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
import type { FetchProvider, ProviderError, SearchProvider } from "./provider-types";
import { err, ok, type Result } from "./result";
import {
  EXA_MCP_DEFAULT_ENDPOINT,
  PARALLEL_MCP_DEFAULT_ENDPOINT,
  SEARCH_MAX_RESPONSE_BYTES,
  SEARCH_TIMEOUT_SECONDS,
  type WebToolsSettings,
} from "./settings";
import type {
  NormalizedSearchResult,
  PublicHttpUrl,
  SearchProviderName,
  SearchQuery,
} from "./types";

/** Dependencies the composition root injects into provider construction. */
export interface ProviderComposition {
  readonly settings: WebToolsSettings;
  readonly http: ProviderHttpClient;
  readonly sessionId: string;
  readonly mcpFor: (endpoint: PublicHttpUrl) => McpHttpClient;
}

/** Create the default MCP client factory (keyless; keys are never attached to MCP endpoints). */
export function defaultMcpFor(endpoint: PublicHttpUrl): McpHttpClient {
  return new McpHttpClient(endpoint, {
    maxResponseBytes: SEARCH_MAX_RESPONSE_BYTES,
    timeoutMs: SEARCH_TIMEOUT_SECONDS.default * 1_000,
  });
}

/** The search provider for one configured name, plus its fetch-rescue provider when it has one. */
interface ProviderPair {
  readonly search: SearchProvider;
  readonly fetch?: FetchProvider;
}

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
    if (settings.endpoints.exa === undefined && apiKey) {
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
        settings.endpoints.parallel === undefined && apiKey
          ? new ParallelApiSearchProvider(apiKey, http)
          : new ParallelMcpSearchProvider(mcp, sessionId),
      // Parallel has no REST fetch provider, so the rescue path always uses MCP.
      fetch: new ParallelMcpFetchProvider(mcp, sessionId),
    };
  },
  brave: ({ settings, http }) => {
    // parseSettings guarantees the key when brave is in the provider list. Brave has no page fetch.
    const apiKey = settings.credentials.braveApiKey;
    return apiKey ? { search: new BraveApiSearchProvider(apiKey, http) } : undefined;
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
export interface SearchChainSuccess {
  readonly provider: SearchProviderName;
  readonly attemptedProviders: readonly SearchProviderName[];
  readonly results: readonly NormalizedSearchResult[];
}

/** Expected failures of the search chain. */
export type SearchChainError =
  | {
      readonly _tag: "UnknownProvider";
      readonly provider: string;
      readonly available: readonly string[];
    }
  | { readonly _tag: "AllProvidersFailed"; readonly attempts: readonly string[] };

/** Run the provider chain in priority order, falling through on provider failures. */
export async function searchWithFallback(
  providers: readonly SearchProvider[],
  input: { readonly query: SearchQuery; readonly maxResults: number },
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly providerOverride?: SearchProviderName | undefined;
  } = {},
): Promise<Result<SearchChainSuccess, SearchChainError>> {
  if (options.providerOverride !== undefined) {
    const selected = providers.filter((provider) => provider.name === options.providerOverride);
    if (selected.length === 0) {
      return err({
        _tag: "UnknownProvider",
        provider: options.providerOverride,
        available: providers.map((provider) => provider.name),
      });
    }
    return runChain(selected, input, options.signal);
  }
  return runChain(providers, input, options.signal);
}

async function runChain(
  providers: readonly SearchProvider[],
  input: { readonly query: SearchQuery; readonly maxResults: number },
  signal?: AbortSignal,
): Promise<Result<SearchChainSuccess, SearchChainError>> {
  const failures: string[] = [];
  const attempted: SearchProviderName[] = [];

  for (const provider of providers) {
    attempted.push(provider.name);
    const result = await provider.search(input, { signal });
    if (result._tag === "ok") {
      return ok({ provider: provider.name, attemptedProviders: attempted, results: result.value });
    }
    failures.push(`${provider.name}: ${renderProviderError(result.error)}`);
  }

  return err({ _tag: "AllProvidersFailed", attempts: failures });
}

function renderProviderError(error: ProviderError): string {
  switch (error._tag) {
    case "ProviderRequestFailed":
      return "unavailable";
    case "ProviderTimedOut":
      return `timed out after ${error.timeoutSeconds}s`;
    case "ProviderCancelled":
      return "cancelled";
    case "ProviderStatusRejected":
      return `rejected (HTTP ${error.status})`;
    case "ProviderProtocolInvalid":
      return "returned an invalid response";
    case "ProviderResponseTooLarge":
      return "response too large";
    case "ProviderToolError":
      return "reported an error";
  }
}
