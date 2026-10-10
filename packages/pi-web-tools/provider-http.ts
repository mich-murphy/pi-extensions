import { Effect } from "effect";
import { readResponseBodyWithLimit, ResponseBodyTooLarge } from "./network";
import {
  parseJsonBody,
  ProviderRequestFailed,
  ProviderResponseTooLarge,
  ProviderStatusRejected,
  ProviderTimedOut,
} from "./provider-types";
import type { ProviderError } from "./provider-types";

/** A bounded, successful (2xx) provider REST response. */
export type ProviderHttpResponse = {
  readonly bodyText: string;
};

/** A JSON request against a provider REST endpoint. */
export type ProviderHttpRequest = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
};

/** Outbound port for provider REST calls. Interrupting a call aborts its request. */
export type ProviderHttpClient = {
  /** POST a JSON body and read a bounded 2xx response. */
  readonly postJson: (
    request: ProviderHttpRequest,
  ) => Effect.Effect<ProviderHttpResponse, ProviderError>;
  /** GET and read a bounded 2xx response. */
  readonly getJson: (
    request: ProviderHttpRequest,
  ) => Effect.Effect<ProviderHttpResponse, ProviderError>;
};

/**
 * Run a provider REST call and parse its body as untrusted JSON.
 *
 * @param response - The provider call.
 * @returns The parsed body, or the call's or the parse's failure.
 */
export function readProviderJson(
  response: Effect.Effect<ProviderHttpResponse, ProviderError>,
): Effect.Effect<unknown, ProviderError> {
  return Effect.flatMap(response, (settled) => Effect.fromResult(parseJsonBody(settled.bodyText)));
}

/** A provider response whose body was read in full, any status. */
export type ProviderRawResponse = {
  readonly response: Response;
  readonly bodyText: string;
};

/**
 * Send one provider request and read its body under a byte cap. Network and stream failures are
 * classified by host; interrupting the effect aborts the request. Status is left to the caller.
 *
 * @param fetchImpl - The fetch implementation.
 * @param url - The provider endpoint.
 * @param init - Request init without a signal; the effect supplies one.
 * @param maxResponseBytes - The body byte cap.
 * @returns The response and its UTF-8 body text.
 */
export function sendProviderRequest(
  fetchImpl: typeof fetch,
  url: string | URL,
  init: Omit<RequestInit, "signal">,
  maxResponseBytes: number,
): Effect.Effect<ProviderRawResponse, ProviderRequestFailed | ProviderResponseTooLarge> {
  const { hostname } = new URL(url);
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: async (signal) => fetchImpl(url, { ...init, signal }),
      catch: (cause) => new ProviderRequestFailed({ hostname, cause }),
    });
    const body = yield* readResponseBodyWithLimit(response, maxResponseBytes).pipe(
      Effect.mapError((error) =>
        error instanceof ResponseBodyTooLarge
          ? new ProviderResponseTooLarge()
          : new ProviderRequestFailed({ hostname, cause: error.cause }),
      ),
    );
    return { response, bodyText: body.toString("utf8") };
  });
}

/**
 * Fail with ProviderTimedOut when an effect outlives its deadline; the effect is interrupted.
 *
 * @param timeoutMs - The deadline in milliseconds.
 * @returns A combinator applying the deadline.
 */
export function withProviderDeadline(
  timeoutMs: number,
): <A, E>(self: Effect.Effect<A, E>) => Effect.Effect<A, E | ProviderTimedOut> {
  return Effect.timeoutOrElse({
    duration: timeoutMs,
    orElse: () =>
      Effect.fail(new ProviderTimedOut({ timeoutSeconds: Math.ceil(timeoutMs / 1000) })),
  });
}

/** Provider REST client with hard timeouts and response byte caps. */
export class FetchProviderHttpClient implements ProviderHttpClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /** POST a JSON body and read a bounded response. */
  postJson(request: ProviderHttpRequest): Effect.Effect<ProviderHttpResponse, ProviderError> {
    return this.request("POST", request);
  }

  /** GET and read a bounded response. */
  getJson(request: ProviderHttpRequest): Effect.Effect<ProviderHttpResponse, ProviderError> {
    return this.request("GET", request);
  }

  private request(
    method: "GET" | "POST",
    request: ProviderHttpRequest,
  ): Effect.Effect<ProviderHttpResponse, ProviderError> {
    const sent = sendProviderRequest(
      this.fetchImpl,
      request.url,
      {
        method,
        headers:
          method === "POST"
            ? { "content-type": "application/json", ...request.headers }
            : request.headers,
        body: method === "POST" && request.body !== undefined ? JSON.stringify(request.body) : null,
      },
      request.maxResponseBytes,
    );
    return Effect.gen(function* () {
      const { response, bodyText } = yield* sent;
      if (response.status < 200 || response.status >= 300) {
        return yield* new ProviderStatusRejected({ status: response.status });
      }
      return { bodyText };
    }).pipe(withProviderDeadline(request.timeoutMs));
  }
}
