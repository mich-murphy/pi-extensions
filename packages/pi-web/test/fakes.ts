import { rm } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname } from "node:path";
import type { Context } from "effect";
import { Duration, Effect, Exit, Layer, Redacted, Result, Schema, SchemaGetter } from "effect";
import { TestClock } from "effect/testing";
import { onTestFinished } from "vitest";
import { CredentialResolver } from "../credentials";
import type { CredentialSnapshot } from "../credentials";
import { FetchPage } from "../fetch-page";
import { McpClients } from "../mcp";
import type { McpClient, McpToolCallResult } from "../mcp";
import { DnsLookup, HttpFetch, PublicWebClient } from "../network";
import type { PublicWebError, PublicWebRequest, PublicWebResponse } from "../network";
import { ProviderHttpClient } from "../provider-http";
import type { ProviderHttpRequest, ProviderHttpResponse } from "../provider-http";
import type { FetchProvider, ProviderError, SearchProvider } from "../provider-types";
import { PublicWebTransport } from "../public-web-transport";
import { getTextContent } from "../render";
import { FetchRescueProviders, SearchProviders } from "../search";
import { parseSettings, WebToolsConfig } from "../settings";
import type { WebToolsSettings } from "../settings";
import { redactSecrets, ToolOutputStore } from "../tool-output";
import { createToolRuntime } from "../tool-runtime";
import type { ToolRuntime } from "../tool-runtime";
import { parsePublicHttpUrl, parseSearchQuery } from "../types";
import type { PublicHttpUrl, SearchQuery } from "../types";

export const UTF8 = new TextDecoder().encoding;

export function publicUrl(input: string): PublicHttpUrl {
  const parsed = parsePublicHttpUrl(input);

  if (Result.isFailure(parsed)) {
    throw new Error(`Invalid test URL: ${input}`);
  }

  return parsed.success;
}

export function settingsFrom(
  environment: Readonly<Record<string, string | undefined>> = {},
): WebToolsSettings {
  const parsed = parseSettings(environment);

  if (Result.isFailure(parsed)) {
    throw new Error(`Invalid test settings: ${parsed.failure.message}`);
  }

  return parsed.success;
}

function syntheticKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed === "" ? undefined : trimmed;
}

function syntheticOutcome(key: string | undefined) {
  return Result.succeed(key === undefined ? undefined : Redacted.make(key));
}

export function credentialSnapshotFrom(
  environment: Readonly<Record<string, string | undefined>> = {},
): CredentialSnapshot {
  const keys = {
    exa: syntheticKey(environment.EXA_API_KEY),
    parallel: syntheticKey(environment.PARALLEL_API_KEY),
    brave: syntheticKey(environment.BRAVE_API_KEY),
  };

  return {
    outcomes: {
      exa: syntheticOutcome(keys.exa),
      parallel: syntheticOutcome(keys.parallel),
      brave: syntheticOutcome(keys.brave),
    },
    secrets: Object.values(keys).filter((key): key is string => key !== undefined),
  };
}

export function searchQuery(input: string): SearchQuery {
  const parsed = parseSearchQuery(input);

  if (Result.isFailure(parsed)) {
    throw new Error(`Invalid test query: ${input}`);
  }

  return parsed.success;
}

type RecordedMcpCall = {
  readonly name: string;
  readonly args: Parameters<McpClient["callTool"]>[1];
};

export function fakeMcpClient(results: readonly Result.Result<McpToolCallResult, ProviderError>[]) {
  const calls: RecordedMcpCall[] = [];
  let index = 0;

  const client: McpClient = {
    callTool: (name, args) =>
      Effect.suspend(() => {
        calls.push({ name, args });
        const result = results[Math.min(index, results.length - 1)];
        index += 1;

        return Effect.fromResult(result ?? Result.succeed({ text: [] }));
      }),
  };

  return { client, calls };
}

export function fakeProviderHttp(
  results: readonly Result.Result<ProviderHttpResponse, ProviderError>[],
) {
  const requests: ProviderHttpRequest[] = [];
  let index = 0;

  const respond = (request: ProviderHttpRequest) =>
    Effect.suspend(() => {
      requests.push(request);
      const result = results[Math.min(index, results.length - 1)];
      index += 1;

      return Effect.fromResult(result ?? Result.succeed({ bodyText: "{}" }));
    });

  const client: ProviderHttpClient["Service"] = {
    postJson: respond,
    getJson: respond,
  };

  return { client, requests };
}

export function fakePublicWeb(result: Result.Result<PublicWebResponse, PublicWebError>) {
  const requests: PublicWebRequest[] = [];

  const client: PublicWebClient["Service"] = {
    get: (request) =>
      Effect.suspend(() => {
        requests.push(request);

        return Effect.fromResult(result);
      }),
  };

  return { client, requests };
}

export function redactorFor(...secrets: readonly string[]): (input: string) => string {
  return (input) => redactSecrets(input, secrets);
}

export function textOf(result: {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}): string {
  return getTextContent(result.content);
}

export function renderText(component: {
  readonly render: (width: number) => readonly string[];
}): string {
  return component
    .render(200)
    .map((line) => line.trimEnd())
    .join("\n");
}

export function textWebResponse(
  text: string,
  contentType = "text/html; charset=utf-8",
): PublicWebResponse {
  return {
    requestedUrl: publicUrl("https://example.com/page"),
    finalUrl: publicUrl("https://example.com/page"),
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    body: Buffer.from(text, "utf8"),
  };
}

function serviceFrom<I, S>(tag: Context.Key<I, S>, layer: Layer.Layer<I>): S {
  return Effect.runSync(
    Effect.gen(function* () {
      return yield* tag;
    }).pipe(Effect.provide(layer)),
  );
}

function fakeHttpFetch(fetchImpl: typeof fetch): Layer.Layer<HttpFetch> {
  return Layer.succeed(HttpFetch, HttpFetch.of({ fetch: fetchImpl }));
}

export type TestLookup = (
  hostname: string,
) => Promise<readonly { readonly address: string; readonly family?: 4 | 6 }[]>;

function resolverFrom(lookup: TestLookup): Layer.Layer<DnsLookup> {
  return Layer.succeed(
    DnsLookup,
    DnsLookup.of({
      lookup: async (hostname) => {
        const records = await lookup(hostname);

        return records.map((record) => {
          const family = record.family ?? isIP(record.address);

          if (family !== 4 && family !== 6) {
            throw new Error(`Invalid test address: ${record.address}`);
          }

          return { address: record.address, family };
        });
      },
    }),
  );
}

export function publicWebClientOverTransport(dependencies: {
  readonly transport: PublicWebTransport["Service"];
  readonly lookup: TestLookup;
}): PublicWebClient["Service"] {
  return serviceFrom(
    PublicWebClient,
    PublicWebClient.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(PublicWebTransport, dependencies.transport),
          resolverFrom(dependencies.lookup),
        ),
      ),
    ),
  );
}

export function publicWebClientWith(dependencies: {
  readonly fetchImpl: (url: URL, init: RequestInit) => Promise<Response>;
  readonly lookup: TestLookup;
}): PublicWebClient["Service"] {
  return publicWebClientOverTransport({
    lookup: dependencies.lookup,
    transport: {
      get: async (url, _addresses, request) =>
        dependencies.fetchImpl(url, {
          method: "GET",
          headers: request.headers,
          signal: request.signal,
          redirect: "manual",
        }),
    },
  });
}

export function providerHttpWith(fetchImpl: typeof fetch): ProviderHttpClient["Service"] {
  return serviceFrom(
    ProviderHttpClient,
    ProviderHttpClient.layer.pipe(Layer.provide(fakeHttpFetch(fetchImpl))),
  );
}

export function mcpClientWith(
  endpoint: PublicHttpUrl,
  options: {
    readonly maxResponseBytes: number;
    readonly timeoutMs: number;
    readonly fetchImpl: typeof fetch;
  },
): McpClient {
  const layer = McpClients.layerWith({
    maxResponseBytes: options.maxResponseBytes,
    timeout: Duration.millis(options.timeoutMs),
  }).pipe(Layer.provide(fakeHttpFetch(options.fetchImpl)));

  return serviceFrom(McpClients, layer).forEndpoint(endpoint);
}

export function recordingMcpClients() {
  const endpoints: PublicHttpUrl[] = [];
  const live = serviceFrom(McpClients, McpClients.layer.pipe(Layer.provide(HttpFetch.layer)));

  const layer = Layer.succeed(
    McpClients,
    McpClients.of({
      forEndpoint: (endpoint) => {
        endpoints.push(endpoint);

        return live.forEndpoint(endpoint);
      },
    }),
  );

  return { endpoints, layer };
}

export function fetchPageWith(client: PublicWebClient["Service"]): FetchPage["Service"] {
  return serviceFrom(
    FetchPage,
    FetchPage.layer.pipe(Layer.provide(Layer.succeed(PublicWebClient, client))),
  );
}

export const trackedToolOutputLayer: Layer.Layer<ToolOutputStore> = Layer.effect(
  ToolOutputStore,
  Effect.gen(function* () {
    const live = yield* ToolOutputStore.pipe(Effect.provide(ToolOutputStore.layer));

    return ToolOutputStore.of({
      writeTextFile: (prefix, fileName, content) =>
        live.writeTextFile(prefix, fileName, content).pipe(
          Effect.tap((path) =>
            Effect.sync(() => {
              const directory = dirname(path);
              onTestFinished(async () => rm(directory, { recursive: true, force: true }));
            }),
          ),
        ),
    });
  }),
);

export function liveToolOutputStore(): ToolOutputStore["Service"] {
  return serviceFrom(ToolOutputStore, trackedToolOutputLayer);
}

export function toolRuntimeWith(services: {
  readonly settings: WebToolsSettings;
  readonly secret?: string;
  readonly credentials?: CredentialResolver["Service"];
  readonly searchProviders?: readonly SearchProvider[];
  readonly fetchProviders?: readonly FetchProvider[];
  readonly fetchPage?: FetchPage["Service"];
  readonly testClock?: boolean;
}): ToolRuntime<
  | SearchProviders
  | FetchRescueProviders
  | FetchPage
  | ToolOutputStore
  | WebToolsConfig
  | CredentialResolver
> {
  const { settings, secret } = services;
  const snapshot = credentialSnapshotFrom({ EXA_API_KEY: secret });

  const credentials =
    services.credentials ??
    CredentialResolver.of({
      resolve: (provider) => Effect.fromResult(snapshot.outcomes[provider]),
    });

  return createToolRuntime(
    Layer.mergeAll(
      Layer.succeed(CredentialResolver, credentials),
      Layer.succeed(
        SearchProviders,
        SearchProviders.of({
          forRequest: () => services.searchProviders ?? [],
        }),
      ),
      Layer.succeed(
        FetchRescueProviders,
        FetchRescueProviders.of({
          forRequest: () => services.fetchProviders ?? [],
        }),
      ),
      Layer.succeed(FetchPage, services.fetchPage ?? FetchPage.of({ fetch: () => Effect.never })),
      trackedToolOutputLayer,
      WebToolsConfig.layer(settings),
      services.testClock === true ? TestClock.layer() : Layer.empty,
    ),
  );
}

export async function settleOnTestClock(
  runtime: ToolRuntime<never>,
  step: Duration.Duration,
  outcome: Promise<unknown>,
): Promise<void> {
  const state = { settled: false };

  const markSettled = () => {
    state.settled = true;
  };

  outcome.then(markSettled, markSettled);

  for (let attempt = 0; attempt < 100 && !state.settled; attempt += 1) {
    const exit = await runtime.runExit(TestClock.adjust(step));

    if (Exit.isFailure(exit)) {
      throw new Error("Advancing the test clock failed");
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  if (!state.settled) {
    throw new Error("The tool call did not settle on the test clock");
  }
}

export const errorMessage = Schema.decodeUnknownSync(
  Schema.Unknown.pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((error) =>
        error instanceof Error ? error.message : "Unexpected failure",
      ),
      encode: SchemaGetter.passthrough({ strict: false }),
    }),
  ),
);
