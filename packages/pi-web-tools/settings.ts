import process from "node:process";
import { Data, Result } from "effect";
import { isPublicHttpUrl, parsePublicHttpUrl } from "./types";
import type { PublicHttpUrl, SearchProviderName, WebFetchFormat } from "./types";

export const WEB_FETCH_FORMATS = [
  "markdown",
  "text",
  "html",
] as const satisfies readonly WebFetchFormat[];
export const SEARCH_PROVIDERS = [
  "exa",
  "parallel",
  "brave",
] as const satisfies readonly SearchProviderName[];
const SEARCH_PROVIDER_NAMES: ReadonlySet<string> = new Set(SEARCH_PROVIDERS);

export const FETCH_TIMEOUT_SECONDS = { default: 30, min: 1, max: 120 } as const;
export const SEARCH_TIMEOUT_SECONDS = { default: 25, min: 1, max: 120 } as const;
export const SEARCH_MAX_RESULTS = { default: 8, min: 1, max: 20 } as const;
const FETCH_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const SEARCH_MAX_RESPONSE_BYTES = 1 * 1024 * 1024;
const FETCH_MAX_REDIRECTS = 5;

/** Brand a built-in endpoint. An invalid one is a defect, so it fails at module load. */
function builtInEndpoint(url: string): PublicHttpUrl {
  if (!isPublicHttpUrl(url)) {
    throw new Error(`Built-in endpoint is not a public HTTP(S) URL: ${url}`);
  }
  return url;
}

/** Official Exa MCP endpoint, usable without an API key. */
export const EXA_MCP_DEFAULT_ENDPOINT = builtInEndpoint("https://mcp.exa.ai/mcp");
/** Official Exa REST search endpoint, used when EXA_API_KEY is present. */
export const EXA_API_SEARCH_URL = "https://api.exa.ai/search";
/** Official Exa REST contents endpoint, used for keyed fetch rescue. */
export const EXA_API_CONTENTS_URL = "https://api.exa.ai/contents";
/** Official Parallel MCP endpoint, usable without an API key. */
export const PARALLEL_MCP_DEFAULT_ENDPOINT = builtInEndpoint("https://search.parallel.ai/mcp");
/** Official Parallel REST search endpoint (GA v1), used when PARALLEL_API_KEY is present. */
export const PARALLEL_API_SEARCH_URL = "https://api.parallel.ai/v1/search";
/** Official Brave REST web search endpoint, used when BRAVE_API_KEY is present. */
export const BRAVE_API_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

export const EXA_API_KEY_ENV = "EXA_API_KEY";
export const PARALLEL_API_KEY_ENV = "PARALLEL_API_KEY";
export const BRAVE_API_KEY_ENV = "BRAVE_API_KEY";
export const PROVIDERS_ENV = "PI_WEB_TOOLS_PROVIDERS";
export const EXA_ENDPOINT_ENV = "PI_WEB_TOOLS_EXA_ENDPOINT";
const PARALLEL_ENDPOINT_ENV = "PI_WEB_TOOLS_PARALLEL_ENDPOINT";
export const FETCH_RESCUE_ENV = "PI_WEB_TOOLS_FETCH_RESCUE";
const FETCH_ALLOW_DOMAINS_ENV = "PI_WEB_TOOLS_FETCH_ALLOW_DOMAINS";
const FETCH_DENY_DOMAINS_ENV = "PI_WEB_TOOLS_FETCH_DENY_DOMAINS";

/** API credentials resolved from the process environment. */
export type WebToolsCredentials = {
  readonly exaApiKey?: string | undefined;
  readonly parallelApiKey?: string | undefined;
  readonly braveApiKey?: string | undefined;
};

/** MCP endpoint overrides for self-hosted or proxied providers. Keys are never sent to overridden endpoints. */
export type WebToolsEndpoints = {
  readonly exa?: PublicHttpUrl | undefined;
  readonly parallel?: PublicHttpUrl | undefined;
};

/** Fully parsed web-tools configuration. */
export type WebToolsSettings = {
  readonly fetch: {
    readonly defaultFormat: WebFetchFormat;
    readonly timeoutSeconds: number;
    readonly maxResponseBytes: number;
    readonly maxRedirects: number;
    readonly rescue: boolean;
    readonly allowDomains: readonly string[];
    readonly denyDomains: readonly string[];
  };
  readonly search: {
    readonly providers: readonly SearchProviderName[];
    readonly timeoutSeconds: number;
    readonly defaultMaxResults: number;
  };
  readonly credentials: WebToolsCredentials;
  readonly endpoints: WebToolsEndpoints;
};

/** A settings parse failure. The message is safe to show the user: it never contains env values. */
export class InvalidSetting extends Data.TaggedError("InvalidSetting")<{
  /** Safe description naming the environment variable, never its value. */
  readonly message: string;
}> {}

/** Expected failures parsing web-tools settings. */
export type SettingsError = InvalidSetting;

function invalid(message: string): Result.Result<never, SettingsError> {
  return Result.fail(new InvalidSetting({ message }));
}

/** Round into inclusive bounds such as FETCH_TIMEOUT_SECONDS; non-finite input gets the default. */
export function clampInteger(
  value: number,
  bounds: { readonly default: number; readonly min: number; readonly max: number },
): number {
  if (!Number.isFinite(value)) {
    return bounds.default;
  }
  return Math.max(bounds.min, Math.min(bounds.max, Math.round(value)));
}

function isSearchProviderName(value: string): value is SearchProviderName {
  return SEARCH_PROVIDER_NAMES.has(value);
}

/** Parse an on/off environment toggle, falling back when unset or unrecognized. */
function parseOnOff(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "on") {
    return true;
  }
  if (normalized === "off") {
    return false;
  }
  return fallback;
}

function parseApiKey(
  value: string | undefined,
  envName: string,
): Result.Result<string | undefined, SettingsError> {
  if (value === undefined) {
    return Result.succeed(undefined);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return Result.succeed(undefined);
  }
  // Control characters in a credential almost always mean a mangled paste or an
  // attempted header-injection; reject fail-closed with a safe message.
  // oxlint-disable-next-line eslint/no-control-regex -- detecting control characters is the point
  if (/[\0-\u001F\u007F]/u.test(trimmed)) {
    return invalid(`${envName} contains control characters and was rejected`);
  }
  return Result.succeed(trimmed);
}

function parseProviderList(
  value: string | undefined,
  braveKeyed: boolean,
): Result.Result<readonly SearchProviderName[], SettingsError> {
  if (value === undefined || !value.trim()) {
    const defaults: SearchProviderName[] = ["exa", "parallel"];
    if (braveKeyed) {
      defaults.push("brave");
    }
    return Result.succeed(defaults);
  }

  // A Set dedupes while keeping first-mention order, which is the chain's priority order.
  const providers = new Set<SearchProviderName>();
  for (const entry of value.split(",")) {
    const normalized = entry.trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    if (!isSearchProviderName(normalized)) {
      return invalid(
        `${PROVIDERS_ENV} contains unknown provider "${normalized}"; expected a comma-separated subset of ${SEARCH_PROVIDERS.join(", ")}`,
      );
    }
    providers.add(normalized);
  }

  if (providers.size === 0) {
    return invalid(`${PROVIDERS_ENV} must name at least one provider`);
  }
  if (providers.has("brave") && !braveKeyed) {
    return invalid(`${PROVIDERS_ENV} enables brave but ${BRAVE_API_KEY_ENV} is not set`);
  }
  return Result.succeed([...providers]);
}

function parseEndpointOverride(
  value: string | undefined,
  envName: string,
): Result.Result<PublicHttpUrl | undefined, SettingsError> {
  if (value === undefined || !value.trim()) {
    return Result.succeed(undefined);
  }
  const parsed = parsePublicHttpUrl(value);
  if (Result.isFailure(parsed)) {
    return invalid(`${envName} must be a public http:// or https:// URL without credentials`);
  }
  return Result.succeed(parsed.success);
}

/** Parse a comma-separated domain list into normalized lowercase hostnames. */
function parseDomainList(value: string | undefined): readonly string[] {
  if (value === undefined) {
    return [];
  }
  const domains = new Set<string>();
  for (const entry of value.split(",")) {
    const normalized = entry.trim().toLowerCase();
    if (normalized) {
      domains.add(normalized);
    }
  }
  return [...domains];
}

/** Parse all web-tools settings from the process environment. */
export function parseSettings(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Result.Result<WebToolsSettings, SettingsError> {
  const exaApiKey = parseApiKey(environment[EXA_API_KEY_ENV], EXA_API_KEY_ENV);
  if (Result.isFailure(exaApiKey)) {
    return Result.fail(exaApiKey.failure);
  }
  const parallelApiKey = parseApiKey(environment[PARALLEL_API_KEY_ENV], PARALLEL_API_KEY_ENV);
  if (Result.isFailure(parallelApiKey)) {
    return Result.fail(parallelApiKey.failure);
  }
  const braveApiKey = parseApiKey(environment[BRAVE_API_KEY_ENV], BRAVE_API_KEY_ENV);
  if (Result.isFailure(braveApiKey)) {
    return Result.fail(braveApiKey.failure);
  }

  const providers = parseProviderList(
    environment[PROVIDERS_ENV],
    braveApiKey.success !== undefined,
  );
  if (Result.isFailure(providers)) {
    return Result.fail(providers.failure);
  }

  const exaEndpoint = parseEndpointOverride(environment[EXA_ENDPOINT_ENV], EXA_ENDPOINT_ENV);
  if (Result.isFailure(exaEndpoint)) {
    return Result.fail(exaEndpoint.failure);
  }
  const parallelEndpoint = parseEndpointOverride(
    environment[PARALLEL_ENDPOINT_ENV],
    PARALLEL_ENDPOINT_ENV,
  );
  if (Result.isFailure(parallelEndpoint)) {
    return Result.fail(parallelEndpoint.failure);
  }

  return Result.succeed({
    fetch: {
      defaultFormat: "markdown",
      timeoutSeconds: FETCH_TIMEOUT_SECONDS.default,
      maxResponseBytes: FETCH_MAX_RESPONSE_BYTES,
      maxRedirects: FETCH_MAX_REDIRECTS,
      rescue: parseOnOff(environment[FETCH_RESCUE_ENV], true),
      allowDomains: parseDomainList(environment[FETCH_ALLOW_DOMAINS_ENV]),
      denyDomains: parseDomainList(environment[FETCH_DENY_DOMAINS_ENV]),
    },
    search: {
      providers: providers.success,
      timeoutSeconds: SEARCH_TIMEOUT_SECONDS.default,
      defaultMaxResults: SEARCH_MAX_RESULTS.default,
    },
    credentials: {
      exaApiKey: exaApiKey.success,
      parallelApiKey: parallelApiKey.success,
      braveApiKey: braveApiKey.success,
    },
    endpoints: { exa: exaEndpoint.success, parallel: parallelEndpoint.success },
  });
}
