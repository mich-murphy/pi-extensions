import { Cause, Effect, Exit, Result } from "effect";
import { assert, describe, expect, test } from "vitest";
import { FetchProviderHttpClient } from "../provider-http";

/** What a recording fetch saw of one request. */
type SeenRequest = {
  readonly method: string | undefined;
  readonly body: BodyInit | null | undefined;
  readonly contentType: string | null;
};

/** A fetch that records each request it receives and replies with `reply`. */
function recordingFetch(reply: () => Response) {
  const seen: SeenRequest[] = [];
  const fetchImpl: typeof fetch = async (_input: unknown, init?: RequestInit) => {
    seen.push({
      method: init?.method,
      body: init?.body,
      contentType: new Headers(init?.headers).get("content-type"),
    });
    return reply();
  };
  return { fetchImpl, seen };
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: new Headers({ "content-type": "application/json" }),
  });
}

/** A response that never arrives; only an abort of the request ends the wait. */
async function neverResponds(): Promise<Response> {
  return new Promise<Response>(() => {
    // Never settles.
  });
}

describe("fetchProviderHttpClient", () => {
  const request = {
    url: "https://api.example/search",
    headers: { "x-api-key": "k" },
    maxResponseBytes: 1024,
    timeoutMs: 5000,
  };

  test("postJson sends the body and returns bounded text", async () => {
    const { fetchImpl, seen } = recordingFetch(() => jsonResponse('{"ok":true}'));
    const client = new FetchProviderHttpClient(fetchImpl);

    const result = await Effect.runPromise(
      Effect.result(client.postJson({ ...request, body: { query: "x" } })),
    );
    expect(result).toStrictEqual(Result.succeed({ bodyText: '{"ok":true}' }));
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.contentType).toBe("application/json");
    expect(seen[0]?.body).toBe('{"query":"x"}');
  });

  test("getJson sends no body or content-type", async () => {
    const { fetchImpl, seen } = recordingFetch(() => jsonResponse("{}"));
    const client = new FetchProviderHttpClient(fetchImpl);

    await Effect.runPromise(Effect.result(client.getJson(request)));
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.body).toBeNull();
    expect(seen[0]?.contentType).toBeNull();
  });

  test("maps failures to tagged errors", async () => {
    const rejected = new FetchProviderHttpClient(async () => jsonResponse("no", 503));
    const rejectedResult = await Effect.runPromise(
      Effect.result(rejected.postJson({ ...request, body: {} })),
    );
    assert(Result.isFailure(rejectedResult));
    expect(rejectedResult.failure._tag).toBe("ProviderStatusRejected");
    expect(rejectedResult.failure.message).toBe("rejected (HTTP 503)");

    const failed = new FetchProviderHttpClient(async () => {
      throw new Error("dns");
    });
    const failedResult = await Effect.runPromise(Effect.result(failed.getJson(request)));
    assert(Result.isFailure(failedResult));
    expect(failedResult.failure._tag).toBe("ProviderRequestFailed");
    expect(failedResult.failure.message).toBe("request to api.example failed");

    const tooLarge = new FetchProviderHttpClient(async () => jsonResponse("x".repeat(4096)));
    const tooLargeResult = await Effect.runPromise(Effect.result(tooLarge.getJson(request)));
    assert(Result.isFailure(tooLargeResult));
    expect(tooLargeResult.failure._tag).toBe("ProviderResponseTooLarge");
  });

  test("a caller abort interrupts the request", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const client = new FetchProviderHttpClient(async () => jsonResponse("{}"));
    const exit = await Effect.runPromiseExit(client.getJson(request), { signal: aborted.signal });
    assert(Exit.isFailure(exit));
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
  });

  test("a request outliving timeoutMs fails with ProviderTimedOut and aborts the fetch", async () => {
    const inits: (RequestInit | undefined)[] = [];
    const client = new FetchProviderHttpClient(async (_input, init) => {
      inits.push(init);
      return neverResponds();
    });
    const result = await Effect.runPromise(
      Effect.result(client.getJson({ ...request, timeoutMs: 20 })),
    );
    assert(Result.isFailure(result));
    expect(result.failure._tag).toBe("ProviderTimedOut");
    expect(result.failure.message).toBe("timed out after 1s");
    expect(inits[0]?.signal?.aborted).toBe(true);
  });
});
