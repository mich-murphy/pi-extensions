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

    const result = await client.postJson({ ...request, body: { query: "x" } });
    expect(result).toStrictEqual({ _tag: "ok", value: { bodyText: '{"ok":true}' } });
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.contentType).toBe("application/json");
    expect(seen[0]?.body).toBe('{"query":"x"}');
  });

  test("getJson sends no body or content-type", async () => {
    const { fetchImpl, seen } = recordingFetch(() => jsonResponse("{}"));
    const client = new FetchProviderHttpClient(fetchImpl);

    await client.getJson(request);
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.body).toBeNull();
    expect(seen[0]?.contentType).toBeNull();
  });

  test("maps failures to tagged errors", async () => {
    const rejected = new FetchProviderHttpClient(async () => jsonResponse("no", 503));
    const rejectedResult = await rejected.postJson({ ...request, body: {} });
    assert(rejectedResult._tag === "err");
    expect(rejectedResult.error).toStrictEqual({ _tag: "ProviderStatusRejected", status: 503 });

    const failed = new FetchProviderHttpClient(async () => {
      throw new Error("dns");
    });
    const failedResult = await failed.getJson(request);
    assert(failedResult._tag === "err");
    expect(failedResult.error).toStrictEqual({ _tag: "ProviderRequestFailed" });

    const tooLarge = new FetchProviderHttpClient(async () => jsonResponse("x".repeat(4096)));
    const tooLargeResult = await tooLarge.getJson(request);
    assert(tooLargeResult._tag === "err");
    expect(tooLargeResult.error).toStrictEqual({ _tag: "ProviderResponseTooLarge" });

    const aborted = new AbortController();
    aborted.abort();
    const cancelled = new FetchProviderHttpClient(async () => jsonResponse("{}"));
    const cancelledResult = await cancelled.getJson(request, { signal: aborted.signal });
    assert(cancelledResult._tag === "err");
    expect(cancelledResult.error).toStrictEqual({ _tag: "ProviderCancelled" });
  });
});
