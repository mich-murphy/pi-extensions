import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { assert, describe, expect, it, test } from "@effect/vitest";
import { Cause, Duration, Effect, Exit, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import { providerHttpWith } from "./fakes";

type LocalServer = {
  readonly url: string;
  readonly close: () => Promise<void>;
};

async function startLocalServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<LocalServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Test HTTP server did not expose a TCP address");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

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
    timeout: Duration.millis(5000),
  };

  it.effect("postJson sends the body and returns bounded text", () =>
    Effect.gen(function* () {
      const { fetchImpl, seen } = recordingFetch(() => jsonResponse('{"ok":true}'));
      const client = providerHttpWith(fetchImpl);

      const result = yield* Effect.result(client.postJson({ ...request, body: { query: "x" } }));
      expect(result).toStrictEqual(Result.succeed({ bodyText: '{"ok":true}' }));
      expect(seen[0]?.method).toBe("POST");
      expect(seen[0]?.contentType).toBe("application/json");
      expect(seen[0]?.body).toBe('{"query":"x"}');
    }),
  );

  it.effect("getJson sends no body or content-type", () =>
    Effect.gen(function* () {
      const { fetchImpl, seen } = recordingFetch(() => jsonResponse("{}"));
      const client = providerHttpWith(fetchImpl);

      yield* Effect.result(client.getJson(request));
      expect(seen[0]?.method).toBe("GET");
      expect(seen[0]?.body).toBeNull();
      expect(seen[0]?.contentType).toBeNull();
    }),
  );

  test("rejects cross-origin redirects without forwarding provider key headers", async () => {
    let destinationRequests = 0;
    const destination = await startLocalServer((_request, response) => {
      destinationRequests += 1;
      response.end("must not be reached");
    });
    const sourceHeaders: string[] = [];
    const source = await startLocalServer((incoming, response) => {
      sourceHeaders.push(
        `${String(incoming.headers["x-api-key"])}|${String(incoming.headers["x-subscription-token"])}`,
      );
      response.writeHead(302, { location: `${destination.url}/collect` });
      response.end();
    });

    try {
      const client = providerHttpWith(globalThis.fetch);
      const providerKeys = [
        { name: "x-api-key", value: "exa-fake-key" },
        { name: "x-api-key", value: "parallel-fake-key" },
        { name: "x-subscription-token", value: "brave-fake-key" },
      ] as const;
      for (const key of providerKeys) {
        const result = await Effect.runPromise(
          Effect.result(
            client.postJson({
              url: `${source.url}/provider`,
              headers: { [key.name]: key.value },
              body: { query: "test" },
              maxResponseBytes: 1024,
              timeout: Duration.seconds(2),
            }),
          ),
        );
        assert(Result.isFailure(result));
        expect(result.failure._tag).toBe("ProviderStatusRejected");
      }

      expect(sourceHeaders).toStrictEqual([
        "exa-fake-key|undefined",
        "parallel-fake-key|undefined",
        "undefined|brave-fake-key",
      ]);
      expect(destinationRequests).toBe(0);
    } finally {
      await source.close();
      await destination.close();
    }
  });

  it.effect("maps failures to tagged errors", () =>
    Effect.gen(function* () {
      const rejected = providerHttpWith(async () => jsonResponse("no", 503));
      const rejectedResult = yield* Effect.result(rejected.postJson({ ...request, body: {} }));
      assert(Result.isFailure(rejectedResult));
      expect(rejectedResult.failure._tag).toBe("ProviderStatusRejected");
      expect(rejectedResult.failure.message).toBe("rejected (HTTP 503)");

      const failed = providerHttpWith(async () => {
        throw new Error("dns");
      });
      const failedResult = yield* Effect.result(failed.getJson(request));
      assert(Result.isFailure(failedResult));
      expect(failedResult.failure._tag).toBe("ProviderRequestFailed");
      expect(failedResult.failure.message).toBe("request to api.example failed");

      const tooLarge = providerHttpWith(async () => jsonResponse("x".repeat(4096)));
      const tooLargeResult = yield* Effect.result(tooLarge.getJson(request));
      assert(Result.isFailure(tooLargeResult));
      expect(tooLargeResult.failure._tag).toBe("ProviderResponseTooLarge");
    }),
  );

  test("a caller abort interrupts the request", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const client = providerHttpWith(async () => jsonResponse("{}"));
    const exit = await Effect.runPromiseExit(client.getJson(request), { signal: aborted.signal });
    assert(Exit.isFailure(exit));
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
  });

  it.effect("a request outliving timeoutMs fails with ProviderTimedOut and aborts the fetch", () =>
    Effect.gen(function* () {
      const inits: (RequestInit | undefined)[] = [];
      const client = providerHttpWith(async (_input, init) => {
        inits.push(init);
        return neverResponds();
      });
      const fiber = yield* Effect.forkChild(
        Effect.result(client.getJson({ ...request, timeout: Duration.millis(20) })),
      );
      yield* TestClock.adjust(Duration.millis(20));
      const result = yield* Fiber.join(fiber);
      assert(Result.isFailure(result));
      expect(result.failure._tag).toBe("ProviderTimedOut");
      expect(result.failure.message).toBe("timed out after 1s");
      expect(inits[0]?.signal?.aborted).toBe(true);
    }),
  );
});
