import { Context, Duration, Effect, Layer } from "effect";
import { HttpFetch, readResponseBodyWithLimit } from "./network";
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
  /** Deadline for the whole call; its whole-second ceiling names it in ProviderTimedOut. */
  readonly timeout: Duration.Duration;
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
 * @param http - The fetch port.
 * @param url - The provider endpoint.
 * @param init - Request init without a signal; the effect supplies one.
 * @param maxResponseBytes - The body byte cap.
 * @returns The response and its UTF-8 body text.
 */
export const sendProviderRequest = Effect.fnUntraced(function* (
  http: HttpFetch["Service"],
  url: string | URL,
  init: Omit<RequestInit, "signal">,
  maxResponseBytes: number,
): Effect.fn.Return<ProviderRawResponse, ProviderRequestFailed | ProviderResponseTooLarge> {
  const { hostname } = new URL(url);
  const response = yield* Effect.tryPromise({
    try: async (signal) => http.fetch(url, { ...init, signal }),
    catch: (cause) => new ProviderRequestFailed({ hostname, cause }),
  });
  const body = yield* readResponseBodyWithLimit(response, maxResponseBytes).pipe(
    Effect.catchTags({
      ResponseBodyTooLarge: () => Effect.fail(new ProviderResponseTooLarge()),
      ResponseBodyReadFailed: (error) =>
        Effect.fail(new ProviderRequestFailed({ hostname, cause: error.cause })),
    }),
  );
  return { response, bodyText: body.toString("utf8") };
});

/**
 * Fail with ProviderTimedOut when an effect outlives its deadline; the effect is interrupted.
 *
 * @param timeout - The deadline; ProviderTimedOut names it in whole seconds, rounded up.
 * @returns A combinator applying the deadline.
 */
export function withProviderDeadline(
  timeout: Duration.Duration,
): <A, E>(self: Effect.Effect<A, E>) => Effect.Effect<A, E | ProviderTimedOut> {
  return Effect.timeoutOrElse({
    duration: timeout,
    orElse: () =>
      Effect.fail(
        new ProviderTimedOut({ timeoutSeconds: Math.ceil(Duration.toMillis(timeout) / 1000) }),
      ),
  });
}

/** Outbound port for provider REST calls, with hard timeouts and response byte caps. */
export class ProviderHttpClient extends Context.Service<
  ProviderHttpClient,
  {
    /** POST a JSON body and read a bounded 2xx response; interrupting the call aborts it. */
    readonly postJson: (
      request: ProviderHttpRequest,
    ) => Effect.Effect<ProviderHttpResponse, ProviderError>;
    /** GET and read a bounded 2xx response; interrupting the call aborts it. */
    readonly getJson: (
      request: ProviderHttpRequest,
    ) => Effect.Effect<ProviderHttpResponse, ProviderError>;
  }
>()("pi-web-tools/provider-http/ProviderHttpClient") {
  /** The live client over HttpFetch. */
  static readonly layer = Layer.effect(
    ProviderHttpClient,
    Effect.gen(function* () {
      const http = yield* HttpFetch;

      const send = Effect.fnUntraced(
        function* (
          method: "GET" | "POST",
          request: ProviderHttpRequest,
        ): Effect.fn.Return<ProviderHttpResponse, ProviderError> {
          const { response, bodyText } = yield* sendProviderRequest(
            http,
            request.url,
            {
              method,
              headers:
                method === "POST"
                  ? { "content-type": "application/json", ...request.headers }
                  : request.headers,
              body:
                method === "POST" && request.body !== undefined
                  ? JSON.stringify(request.body)
                  : null,
            },
            request.maxResponseBytes,
          );
          if (response.status < 200 || response.status >= 300) {
            return yield* new ProviderStatusRejected({ status: response.status });
          }
          return { bodyText };
        },
        (effect, _method, request) => withProviderDeadline(request.timeout)(effect),
      );

      const postJson = Effect.fn("ProviderHttpClient.postJson")(function* (
        request: ProviderHttpRequest,
      ): Effect.fn.Return<ProviderHttpResponse, ProviderError> {
        return yield* send("POST", request);
      });
      const getJson = Effect.fn("ProviderHttpClient.getJson")(function* (
        request: ProviderHttpRequest,
      ): Effect.fn.Return<ProviderHttpResponse, ProviderError> {
        return yield* send("GET", request);
      });
      return ProviderHttpClient.of({ postJson, getJson });
    }),
  );
}
