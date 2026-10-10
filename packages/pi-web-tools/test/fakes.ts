import type { Context } from "effect";
import { Duration, Effect, Exit, Layer, Redacted, Result } from "effect";
import { TestClock } from "effect/testing";
import { FetchPage } from "../fetch-page";
import { McpClients } from "../mcp";
import type { McpClient, McpToolCallResult } from "../mcp";
import { DnsLookup, HttpFetch, PublicWebClient } from "../network";
import type { PublicWebError, PublicWebRequest, PublicWebResponse } from "../network";
import { ProviderHttpClient } from "../provider-http";
import type { ProviderHttpRequest, ProviderHttpResponse } from "../provider-http";
import type { FetchProvider, ProviderError, SearchProvider } from "../provider-types";
import { FetchRescueProviders, SearchProviders } from "../search";
import { parseSettings, WebToolsConfig } from "../settings";
import type { WebToolsSettings } from "../settings";
import { ToolOutputStore } from "../tool-output";
import { createToolRuntime } from "../tool-runtime";
import type { ToolRuntime } from "../tool-runtime";
import { parsePublicHttpUrl, parseSearchQuery } from "../types";
import type { PublicHttpUrl, SearchQuery } from "../types";

/** The WHATWG name of UTF-8, which parsed charsets and decoders report. */
export const UTF8 = "utf-8";

/** Parse a test URL through the real parser; an invalid one is a broken test. */
export function publicUrl(input: string): PublicHttpUrl {
  const parsed = parsePublicHttpUrl(input);
  if (Result.isFailure(parsed)) {
    throw new Error(`Invalid test URL: ${input}`);
  }
  return parsed.success;
}

/** Parse test settings from an environment through the real parser; invalid ones are a broken test. */
export function settingsFrom(
  environment: Readonly<Record<string, string | undefined>> = {},
): WebToolsSettings {
  const parsed = parseSettings(environment);
  if (Result.isFailure(parsed)) {
    throw new Error(`Invalid test settings: ${parsed.failure.message}`);
  }
  return parsed.success;
}

/** Parse a test query through the real parser; an invalid one is a broken test. */
export function searchQuery(input: string): SearchQuery {
  const parsed = parseSearchQuery(input);
  if (Result.isFailure(parsed)) {
    throw new Error(`Invalid test query: ${input}`);
  }
  return parsed.success;
}

/** Recorded MCP call for assertions. */
type RecordedMcpCall = {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
};

/** Fake MCP client returning programmed results in order. */
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

/** Fake provider HTTP client returning programmed results in order. */
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

/** Fake public web client returning a programmed result. */
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

/** Extract the joined text of a pi tool result for assertions. */
export function textOf(result: {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}): string {
  return result.content
    .filter(
      (item): item is { type: "text"; text: string } =>
        item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

/** Render a pi-tui Text component to its visible text, without the padding to full width. */
export function renderText(component: {
  readonly render: (width: number) => readonly string[];
}): string {
  return component
    .render(200)
    .map((line) => line.trimEnd())
    .join("\n");
}

/** Build a text public-web response. */
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

/** Build a service from a layer whose dependencies are all provided. */
function serviceFrom<I, S>(tag: Context.Key<I, S>, layer: Layer.Layer<I>): S {
  return Effect.runSync(
    Effect.gen(function* () {
      return yield* tag;
    }).pipe(Effect.provide(layer)),
  );
}

/** A fake HttpFetch layer delegating every request to a test fetch. */
function fakeHttpFetch(fetchImpl: typeof fetch): Layer.Layer<HttpFetch> {
  return Layer.succeed(HttpFetch, HttpFetch.of({ fetch: fetchImpl }));
}

/** The live public web client over a test fetch and a test resolver. */
export function publicWebClientWith(dependencies: {
  readonly fetchImpl: typeof fetch;
  readonly lookup: DnsLookup["Service"]["lookup"];
}): PublicWebClient["Service"] {
  const outbound = Layer.mergeAll(
    fakeHttpFetch(dependencies.fetchImpl),
    Layer.succeed(DnsLookup, DnsLookup.of({ lookup: dependencies.lookup })),
  );
  return serviceFrom(PublicWebClient, PublicWebClient.layer.pipe(Layer.provide(outbound)));
}

/** The live provider HTTP client over a test fetch. */
export function providerHttpWith(fetchImpl: typeof fetch): ProviderHttpClient["Service"] {
  return serviceFrom(
    ProviderHttpClient,
    ProviderHttpClient.layer.pipe(Layer.provide(fakeHttpFetch(fetchImpl))),
  );
}

/** The live MCP client for one endpoint over a test fetch. */
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

/**
 * Live MCP clients that record every endpoint requested; provider-construction tests never send a
 * request.
 */
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

/** The live fetch-page service over a (fake) public web client. */
export function fetchPageWith(client: PublicWebClient["Service"]): FetchPage["Service"] {
  return serviceFrom(
    FetchPage,
    FetchPage.layer.pipe(Layer.provide(Layer.succeed(PublicWebClient, client))),
  );
}

/** The live temp-file tool output store. */
export function liveToolOutputStore(): ToolOutputStore["Service"] {
  return serviceFrom(ToolOutputStore, ToolOutputStore.layer);
}

/**
 * A tool runtime over fake services and the live temp-file output store. `secret` is configured as
 * the Exa key, so tool output must scrub it; unset services never answer. With `testClock`, the
 * runtime's clock is a TestClock that only `settleOnTestClock` moves.
 */
export function toolRuntimeWith(services: {
  readonly settings: WebToolsSettings;
  readonly secret?: string;
  readonly searchProviders?: readonly SearchProvider[];
  readonly fetchProviders?: readonly FetchProvider[];
  readonly fetchPage?: FetchPage["Service"];
  readonly testClock?: boolean;
}): ToolRuntime<
  SearchProviders | FetchRescueProviders | FetchPage | ToolOutputStore | WebToolsConfig
> {
  const { settings, secret } = services;
  const credentials =
    secret === undefined
      ? settings.credentials
      : { ...settings.credentials, exaApiKey: Redacted.make(secret) };
  return createToolRuntime(
    Layer.mergeAll(
      Layer.succeed(SearchProviders, SearchProviders.of(services.searchProviders ?? [])),
      Layer.succeed(FetchRescueProviders, FetchRescueProviders.of(services.fetchProviders ?? [])),
      Layer.succeed(FetchPage, services.fetchPage ?? FetchPage.of({ fetch: () => Effect.never })),
      ToolOutputStore.layer,
      WebToolsConfig.layer({ ...settings, credentials }),
      services.testClock === true ? TestClock.layer() : Layer.empty,
    ),
  );
}

/**
 * Settle a tool call running on a `toolRuntimeWith({ testClock: true })` runtime by advancing its
 * TestClock in `step`s, yielding to real time between steps so the program can reach its sleeps.
 */
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
