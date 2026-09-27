import { describe, expect, test } from "vitest";
import { FetchProviderHttpClient } from "../provider-http";

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: new Headers({ "content-type": "application/json" }),
  });
}

describe("FetchProviderHttpClient", () => {
  const request = {
    url: "https://api.example/search",
    headers: { "x-api-key": "k" },
    maxResponseBytes: 1024,
    timeoutMs: 5_000,
  };

  test("postJson sends the body and returns bounded text", async () => {
    const seen: {
      method?: string | undefined;
      body?: string | undefined;
      contentType?: string | null;
    } = {};
    const client = new FetchProviderHttpClient(((_input: unknown, init?: RequestInit) => {
      seen.method = init?.method;
      seen.body = String(init?.body);
      seen.contentType = new Headers(init?.headers).get("content-type");
      return Promise.resolve(jsonResponse('{"ok":true}'));
    }) as typeof fetch);

    const result = await client.postJson({ ...request, body: { query: "x" } });
    expect(result).toEqual({ _tag: "ok", value: { bodyText: '{"ok":true}' } });
    expect(seen.method).toBe("POST");
    expect(seen.contentType).toBe("application/json");
    expect(seen.body).toBe('{"query":"x"}');
  });

  test("getJson sends no body or content-type", async () => {
    const seen: { method?: string | undefined; body?: unknown; contentType?: string | null } = {};
    const client = new FetchProviderHttpClient(((_input: unknown, init?: RequestInit) => {
      seen.method = init?.method;
      seen.body = init?.body;
      seen.contentType = new Headers(init?.headers).get("content-type");
      return Promise.resolve(jsonResponse("{}"));
    }) as typeof fetch);

    await client.getJson(request);
    expect(seen.method).toBe("GET");
    expect(seen.body).toBeNull();
    expect(seen.contentType).toBeNull();
  });

  test("maps failures to tagged errors", async () => {
    const rejected = new FetchProviderHttpClient((() =>
      Promise.resolve(jsonResponse("no", 503))) as typeof fetch);
    const rejectedResult = await rejected.postJson({ ...request, body: {} });
    expect(rejectedResult._tag).toBe("err");
    if (rejectedResult._tag !== "err") return;
    expect(rejectedResult.error).toEqual({ _tag: "ProviderStatusRejected", status: 503 });

    const failed = new FetchProviderHttpClient((() =>
      Promise.reject(new Error("dns"))) as typeof fetch);
    const failedResult = await failed.getJson(request);
    expect(failedResult._tag).toBe("err");
    if (failedResult._tag !== "err") return;
    expect(failedResult.error).toEqual({ _tag: "ProviderRequestFailed" });

    const tooLarge = new FetchProviderHttpClient((() =>
      Promise.resolve(jsonResponse("x".repeat(4096)))) as typeof fetch);
    const tooLargeResult = await tooLarge.getJson(request);
    expect(tooLargeResult._tag).toBe("err");
    if (tooLargeResult._tag !== "err") return;
    expect(tooLargeResult.error).toEqual({ _tag: "ProviderResponseTooLarge" });

    const aborted = new AbortController();
    aborted.abort();
    const cancelled = new FetchProviderHttpClient((() =>
      Promise.resolve(jsonResponse("{}"))) as typeof fetch);
    const cancelledResult = await cancelled.getJson(request, { signal: aborted.signal });
    expect(cancelledResult._tag).toBe("err");
    if (cancelledResult._tag !== "err") return;
    expect(cancelledResult.error).toEqual({ _tag: "ProviderCancelled" });
  });
});
