import { createOperationSignal, isAbortError, readResponseBodyWithLimit } from "./network";
import { classifyProviderAbort } from "./provider-types";
import type { ProviderError } from "./provider-types";
import { err, ok } from "./result";
import type { Result } from "./result";

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

/** Outbound port for provider REST calls. */
export type ProviderHttpClient = {
  readonly postJson: (
    request: ProviderHttpRequest,
    options?: { readonly signal?: AbortSignal | undefined },
  ) => Promise<Result<ProviderHttpResponse, ProviderError>>;
  readonly getJson: (
    request: ProviderHttpRequest,
    options?: { readonly signal?: AbortSignal | undefined },
  ) => Promise<Result<ProviderHttpResponse, ProviderError>>;
};

/** Provider REST client with hard timeouts and response byte caps. */
export class FetchProviderHttpClient implements ProviderHttpClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /** POST a JSON body and read a bounded response. */
  async postJson(
    request: ProviderHttpRequest,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<Result<ProviderHttpResponse, ProviderError>> {
    return this.request("POST", request, options);
  }

  /** GET and read a bounded response. */
  async getJson(
    request: ProviderHttpRequest,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<Result<ProviderHttpResponse, ProviderError>> {
    return this.request("GET", request, options);
  }

  private async request(
    method: "GET" | "POST",
    request: ProviderHttpRequest,
    options: { readonly signal?: AbortSignal | undefined },
  ): Promise<Result<ProviderHttpResponse, ProviderError>> {
    const composed = createOperationSignal(request.timeoutMs, options.signal);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(request.url, {
          method,
          headers:
            method === "POST"
              ? { "content-type": "application/json", ...request.headers }
              : request.headers,
          body:
            method === "POST" && request.body !== undefined ? JSON.stringify(request.body) : null,
          signal: composed.signal,
        });
      } catch (error: unknown) {
        if (composed.signal.aborted || isAbortError(error)) {
          return err(classifyProviderAbort(composed.signal));
        }
        return err({ _tag: "ProviderRequestFailed" });
      }

      const body = await readResponseBodyWithLimit(
        response,
        request.maxResponseBytes,
        composed.signal,
      );
      if (body._tag === "err") {
        if (composed.signal.aborted) {
          return err(classifyProviderAbort(composed.signal));
        }
        if (body.error._tag === "BodyTooLarge") {
          return err({ _tag: "ProviderResponseTooLarge" });
        }
        return err({ _tag: "ProviderRequestFailed" });
      }

      if (response.status < 200 || response.status >= 300) {
        return err({ _tag: "ProviderStatusRejected", status: response.status });
      }

      return ok({ bodyText: body.value.toString("utf8") });
    } finally {
      composed.cleanup();
    }
  }
}
