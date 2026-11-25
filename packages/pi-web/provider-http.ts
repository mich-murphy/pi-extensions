import { Context, Duration, Effect, Layer } from "effect";
import { HttpFetch, readResponseBodyWithLimit, sanitizeNetworkFailure } from "./network";
import {
  parseJsonBody,
  ProviderRequestFailed,
  ProviderResponseTooLarge,
  ProviderStatusRejected,
  ProviderTimedOut,
} from "./provider-types";
import type { ProviderError, ProviderJson } from "./provider-types";
import { withSafeSpan } from "./telemetry";

export type ProviderHttpResponse = {
  readonly bodyText: string;
};

export type ProviderHttpRequest = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: ProviderJson;
  readonly maxResponseBytes: number;
  readonly timeout: Duration.Duration;
};

export function readProviderJson(
  response: Effect.Effect<ProviderHttpResponse, ProviderError>,
): Effect.Effect<ProviderJson, ProviderError> {
  return Effect.flatMap(response, (settled) => Effect.fromResult(parseJsonBody(settled.bodyText)));
}

export type ProviderRawResponse = {
  readonly response: Response;
  readonly bodyText: string;
};

export const sendProviderRequest = Effect.fnUntraced(function* (
  http: HttpFetch["Service"],
  url: string | URL,
  init: Omit<RequestInit, "signal">,
  maxResponseBytes: number,
): Effect.fn.Return<ProviderRawResponse, ProviderRequestFailed | ProviderResponseTooLarge> {
  const { hostname } = new URL(url);
  const response = yield* Effect.tryPromise({
    try: async (signal) => http.fetch(url, { ...init, signal, redirect: "manual" }),
    catch: (cause) => new ProviderRequestFailed({ hostname, cause: sanitizeNetworkFailure(cause) }),
  });
  const body = yield* readResponseBodyWithLimit(response, maxResponseBytes).pipe(
    Effect.catchTags({
      ResponseBodyTooLarge: () => Effect.fail(new ProviderResponseTooLarge()),
      ResponseBodyReadFailed: (error) =>
        Effect.fail(
          new ProviderRequestFailed({ hostname, cause: sanitizeNetworkFailure(error.cause) }),
        ),
    }),
  );
  return { response, bodyText: body.toString("utf8") };
});

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

export class ProviderHttpClient extends Context.Service<
  ProviderHttpClient,
  {
    readonly postJson: (
      request: ProviderHttpRequest,
    ) => Effect.Effect<ProviderHttpResponse, ProviderError>;
    readonly getJson: (
      request: ProviderHttpRequest,
    ) => Effect.Effect<ProviderHttpResponse, ProviderError>;
  }
>()("pi-web/provider-http/ProviderHttpClient") {
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

      const postJson = Effect.fnUntraced(function* (
        request: ProviderHttpRequest,
      ): Effect.fn.Return<ProviderHttpResponse, ProviderError> {
        return yield* withSafeSpan(
          "ProviderHttpClient.postJson",
          send("POST", request),
          safeProviderFailure,
        );
      });
      const getJson = Effect.fnUntraced(function* (
        request: ProviderHttpRequest,
      ): Effect.fn.Return<ProviderHttpResponse, ProviderError> {
        return yield* withSafeSpan(
          "ProviderHttpClient.getJson",
          send("GET", request),
          safeProviderFailure,
        );
      });
      return ProviderHttpClient.of({ postJson, getJson });
    }),
  );
}

function safeProviderFailure(error: ProviderError) {
  return {
    type: error._tag,
    network:
      error._tag === "ProviderRequestFailed" ? sanitizeNetworkFailure(error.cause) : undefined,
  };
}
