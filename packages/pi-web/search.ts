import { randomUUID } from "node:crypto";
import { Context, Data, Effect, Layer, Match, Predicate, Result, Schema } from "effect";
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
import type { FetchProvider, ProviderError, SearchProvider } from "./provider-types";
import {
  EXA_MCP_DEFAULT_ENDPOINT,
  PARALLEL_MCP_DEFAULT_ENDPOINT,
  SEARCH_PROVIDERS,
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

type ProviderRoute = Data.TaggedEnum<{
  OfficialApi: { readonly apiKey: Redacted.Redacted };
  KeylessMcp: { readonly endpoint: PublicHttpUrl; readonly freeTier: boolean };
  Failed: { readonly error: CredentialFailure };
}>;

const ProviderRoute = Data.taggedEnum<ProviderRoute>();

function selectProviderRoute(
  outcome: CredentialSnapshot["outcomes"][SearchProviderName],
  override: PublicHttpUrl | undefined,
  defaultEndpoint: PublicHttpUrl,
): ProviderRoute {
  if (override !== undefined) {
    return ProviderRoute.KeylessMcp({ endpoint: override, freeTier: false });
  }

  if (Result.isFailure(outcome)) {
    return ProviderRoute.Failed({ error: outcome.failure });
  }

  return outcome.success === undefined
    ? ProviderRoute.KeylessMcp({ endpoint: defaultEndpoint, freeTier: true })
    : ProviderRoute.OfficialApi({ apiKey: outcome.success });
}

function onFreeTier(provider: SearchProvider, freeTier: boolean): SearchProvider {
  return freeTier
    ? {
        name: provider.name,
        transport: provider.transport,
        freeTier: true,
        search: (input) => provider.search(input),
      }
    : provider;
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

    return ProviderRoute.$match(route, {
      Failed: ({ error }) => failedPair("exa", error),
      OfficialApi: ({ apiKey }) => ({
        search: new ExaApiSearchProvider(apiKey, http),
        fetch: new ExaApiFetchProvider(apiKey, http),
      }),
      KeylessMcp: ({ endpoint, freeTier }) => {
        const mcp = mcpFor(endpoint);

        return {
          search: onFreeTier(new ExaMcpSearchProvider(mcp), freeTier),
          fetch: new ExaMcpFetchProvider(mcp),
        };
      },
    });
  },
  parallel: ({ settings, snapshot, http, sessionId, mcpFor }) => {
    const route = selectProviderRoute(
      snapshot.outcomes.parallel,
      settings.endpoints.parallel,
      PARALLEL_MCP_DEFAULT_ENDPOINT,
    );

    return ProviderRoute.$match(route, {
      Failed: ({ error }) => failedPair("parallel", error),
      OfficialApi: ({ apiKey }) => {
        const mcp = mcpFor(PARALLEL_MCP_DEFAULT_ENDPOINT);

        return {
          search: new ParallelApiSearchProvider(apiKey, http),
          fetch: new ParallelMcpFetchProvider(mcp, sessionId),
        };
      },
      KeylessMcp: ({ endpoint, freeTier }) => {
        const mcp = mcpFor(endpoint);

        return {
          search: onFreeTier(new ParallelMcpSearchProvider(mcp, sessionId), freeTier),
          fetch: new ParallelMcpFetchProvider(mcp, sessionId),
        };
      },
    });
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

class ProviderPairs extends Context.Service<
  ProviderPairs,
  {
    readonly forRequest: (snapshot: CredentialSnapshot) => readonly ProviderPair[];
  }
>()("pi-web/search/ProviderPairs") {
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

export class SearchProviders extends Context.Service<
  SearchProviders,
  {
    readonly forRequest: (snapshot: CredentialSnapshot) => readonly SearchProvider[];
  }
>()("pi-web/search/SearchProviders") {
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

export class FetchRescueProviders extends Context.Service<
  FetchRescueProviders,
  { readonly forRequest: (snapshot: CredentialSnapshot) => readonly FetchProvider[] }
>()("pi-web/search/FetchRescueProviders") {
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

export type SearchChainSuccess = {
  readonly provider: SearchProviderName;
  readonly attemptedProviders: readonly SearchProviderName[];
  readonly results: readonly NormalizedSearchResult[];
};

export class UnknownProvider extends Schema.TaggedError<UnknownProvider>()("UnknownProvider", {
  provider: Schema.String,
  available: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `Provider "${this.provider}" is not enabled (\`PI_WEB_PROVIDERS\`). Available: ${this.available.join(", ")}.`;
  }
}

export class AllProvidersFailed extends Schema.TaggedError<AllProvidersFailed>()(
  "AllProvidersFailed",
  {
    attempts: Schema.Array(Schema.String),
    freeTierRateLimited: Schema.optional(Schema.Array(Schema.Literals(SEARCH_PROVIDERS))),
  },
) {
  override get message(): string {
    const limited = this.freeTierRateLimited ?? [];

    if (limited.length > 0 && limited.length === this.attempts.length) {
      return `Free-tier rate limit on ${limited.join(", ")}. Ask the user to add a key with \`/login pi-web-${limited[0]}\`.`;
    }

    return `All search providers failed (${this.attempts.join("; ")})`;
  }
}

const RATE_LIMIT_TEXT = /rate.?limit|too many requests/iu;

function isFreeTierRateLimit(provider: SearchProvider, error: ProviderError): boolean {
  if (provider.freeTier !== true) {
    return false;
  }

  return Match.value(error).pipe(
    Match.tag("ProviderStatusRejected", ({ status }) => status === 429),
    Match.tag("ProviderToolError", ({ detail }) => RATE_LIMIT_TEXT.test(detail)),
    Match.orElse(() => false),
  );
}

const MAX_PROVIDER_DETAIL = 70;
const URL_PLACEHOLDER = "[URL omitted]";
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function boundedDetail(detail: string): string {
  const points = [...GRAPHEMES.segment(detail)].map(({ segment }) => segment);

  if (points.length <= MAX_PROVIDER_DETAIL) {
    return detail;
  }

  const space = points
    .slice(0, MAX_PROVIDER_DETAIL + 1)
    .join("")
    .lastIndexOf(" ");

  let cut = space > 0 ? space : points.slice(0, MAX_PROVIDER_DETAIL - 1).join("").length;
  const marker = detail.lastIndexOf(URL_PLACEHOLDER, cut - 1);

  if (marker !== -1 && marker + URL_PLACEHOLDER.length > cut) {
    cut = marker > 0 ? marker : URL_PLACEHOLDER.length;
  }

  return `${detail
    .slice(0, cut)
    .trimEnd()
    .replace(/[,;:.]+$/u, "")}…`;
}

function attemptReason(error: ProviderError): string {
  return Predicate.isTagged("ProviderToolError")(error) && error.detail !== ""
    ? `reported an error: ${boundedDetail(error.detail)}`
    : error.message;
}

export type SearchChainError = UnknownProvider | AllProvidersFailed;

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
  const freeTierRateLimited: SearchProviderName[] = [];
  const attempted: SearchProviderName[] = [];

  for (const provider of providers) {
    attempted.push(provider.name);
    const result = yield* Effect.result(provider.search(input));

    if (Result.isSuccess(result)) {
      return { provider: provider.name, attemptedProviders: attempted, results: result.success };
    }

    if (isFreeTierRateLimit(provider, result.failure)) {
      freeTierRateLimited.push(provider.name);
      failures.push(
        `${provider.name}: free-tier rate limit; the user can add a key with \`/login pi-web-${provider.name}\``,
      );
    } else {
      failures.push(`${provider.name}: ${attemptReason(result.failure)}`);
    }
  }

  return yield* new AllProvidersFailed(
    freeTierRateLimited.length === 0
      ? { attempts: failures }
      : { attempts: failures, freeTierRateLimited },
  );
});
