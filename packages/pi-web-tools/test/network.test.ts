import { Cause, Effect, Exit, Result } from "effect";
import { assert, describe, expect, test } from "vitest";
import type { PublicWebError, PublicWebRequest } from "../network";
import {
  classifyMimeType,
  decodeTextBuffer,
  describeNetworkFailure,
  FetchPublicWebClient,
  HttpStatusRejected,
  isPrivateOrLocalIp,
  parseContentType,
  PrivateHostBlocked,
  readResponseBodyWithLimit,
  RedirectLimitExceeded,
  RedirectLocationInvalid,
  RedirectLocationMissing,
  RedirectProtocolUnsupported,
  ResponseBodyReadFailed,
  ResponseBodyTooLarge,
  ResponseTooLarge,
  UrlCredentialsUnsupported,
} from "../network";
import type { PublicHttpUrl } from "../types";
import { UTF8, publicUrl } from "./fakes";

describe("isPrivateOrLocalIp", () => {
  const blocked = [
    "10.0.0.1",
    "127.0.0.1",
    "0.0.0.0",
    "169.254.1.1",
    "192.168.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "100.64.0.1",
    "100.127.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12::ab",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:10.1.2.3",
    "[::1]",
    // IPv4-mapped loopback written other ways.
    "::FFFF:7F00:1",
    "0:0:0:0:0:ffff:127.0.0.1",
    // IPv4-compatible (::/96), even when the embedded address is public.
    "::8.8.8.8",
    // NAT64 (64:ff9b::/96) wrapping 10.0.0.1.
    "64:ff9b::a00:1",
    "64:ff9b::10.0.0.1",
    // IPv4 multicast (224.0.0.0/4) and reserved (240.0.0.0/4).
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
    "::ffff:224.0.0.1",
    // IPv6 multicast (ff00::/8) and the top of link-local (fe80::/10).
    "ff02::1",
    "ff0e::1",
    "febf::1",
  ];

  test.each(blocked)("blocks %s", (ip) => {
    expect(isPrivateOrLocalIp(ip)).toBe(true);
  });

  const allowed = [
    "8.8.8.8",
    "1.1.1.1",
    "172.15.0.1",
    "172.32.0.1",
    "100.63.0.1",
    "100.128.0.1",
    "2001:4860:4860::8888",
    "not-an-ip",
    // A mapped public address stays public: the IPv4-compatible range is ::/96, not ::/8.
    "::ffff:8.8.8.8",
    // Just outside the multicast, NAT64, and link-local ranges.
    "223.255.255.255",
    "64:ff9b:1::1",
    "fec0::1",
    // Expand to 00fc:: and 0fe8::, outside fc00::/7 and fe80::/10 despite the textual prefix.
    "fc::1",
    "fe8::1",
  ];

  test.each(allowed)("allows %s", (ip) => {
    expect(isPrivateOrLocalIp(ip)).toBe(false);
  });
});

describe("parseContentType", () => {
  test("parses mime and charset", () => {
    const parsed = parseContentType("text/html; charset=UTF-8");
    expect(parsed.mime).toBe("text/html");
    expect(parsed.charset).toBe(UTF8);
    expect(parsed.kind).toBe("html");
  });
});

describe("classifyMimeType", () => {
  const cases = [
    ["text/html", "html"],
    [" TEXT/HTML ", "html"],
    ["application/xhtml+xml", "html"],
    ["image/png", "raster-image"],
    ["image/jpeg", "raster-image"],
    ["image/gif", "raster-image"],
    ["image/webp", "raster-image"],
    ["image/svg+xml", "svg"],
    ["IMAGE/SVG+XML", "svg"],
    ["text/plain", "text"],
    ["text/csv", "text"],
    ["application/json", "text"],
    ["application/xml", "text"],
    ["application/javascript", "text"],
    ["application/x-javascript", "text"],
    ["application/ecmascript", "text"],
    ["application/ld+json", "text"],
    ["application/rss+xml", "text"],
    ["application/atom+xml", "text"],
    ["application/hal+json", "text"],
    ["", "binary"],
    ["   ", "binary"],
    ["application/octet-stream", "binary"],
    ["application/pdf", "binary"],
    ["image/avif", "binary"],
    ["video/mp4", "binary"],
  ] as const;

  test.each(cases)("classifies %j as %s", (mime, kind) => {
    expect(classifyMimeType(mime)).toBe(kind);
  });
});

describe("decodeTextBuffer", () => {
  test("decodes utf-8 by default and falls back on unknown charsets", () => {
    expect(decodeTextBuffer(Buffer.from("héllo", "utf8")).text).toBe("héllo");
    expect(decodeTextBuffer(Buffer.from("abc"), "utf-16le").text).not.toBe("abc");
    expect(decodeTextBuffer(Buffer.from("abc"), "utf8").decoder).toBe(UTF8);
    expect(decodeTextBuffer(Buffer.from("abc"), "bogus-charset").decoder).toBe(UTF8);
  });
});

function makeRequest(overrides: Partial<PublicWebRequest> = {}): PublicWebRequest {
  return {
    url: publicUrl("https://example.com/"),
    accept: "*/*",
    userAgent: "test-agent",
    fallbackUserAgent: "fallback-agent",
    maxRedirects: 5,
    maxResponseBytes: 1024 * 1024,
    blockPrivateHosts: true,
    ...overrides,
  };
}

function responseOf(init: {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}): Response {
  return new Response(init.body ?? "", {
    status: init.status,
    headers: new Headers(init.headers ?? {}),
  });
}

type BodyPull = (controller: ReadableStreamDefaultController<Uint8Array>) => void;

/**
 * A response over a body stream that is pulled only on read and records whether the client
 * cancelled it. Without a pull, reading the body never settles.
 */
function trackedResponse(
  init: { readonly status: number; readonly headers?: Readonly<Record<string, string>> },
  source: { readonly pull?: BodyPull } = {},
): { readonly response: Response; readonly wasCancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      ...source,
      cancel: () => {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    response: new Response(body, { status: init.status, headers: new Headers(init.headers ?? {}) }),
    wasCancelled: () => cancelled,
  };
}

/** A client whose fetch records each hop and delegates to `respond`, over an empty DNS. */
function recordingClient(
  respond: (url: string) => Response,
  lookup: () => Promise<readonly { address: string }[]> = async () => [],
) {
  const hops: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
  const fetchImpl: typeof fetch = async (input: unknown, init?: RequestInit) => {
    hops.push({ url: String(input), init });
    // Reply on a later microtask, as a real fetch would.
    await Promise.resolve();
    return respond(String(input));
  };
  return { client: new FetchPublicWebClient({ fetchImpl, lookup }), hops };
}

/** Replies to successive fetches in order, repeating the last reply. */
function inOrder(...replies: readonly (() => Response)[]): () => Response {
  let index = 0;
  return () => {
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (reply === undefined) {
      throw new Error("No reply scripted");
    }
    return reply();
  };
}

/** A URL the parser would reject, to check that the client defends itself anyway. */
function unparsedUrl(input: string): PublicHttpUrl {
  return input as PublicHttpUrl;
}

/** An already-aborted signal. */
function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

/** Run a client call to its success or typed failure. */
async function run<A, E>(effect: Effect.Effect<A, E>): Promise<Result.Result<A, E>> {
  return Effect.runPromise(Effect.result(effect));
}

/** Run a client call under a caller signal and report whether it ended interrupted. */
async function wasInterrupted(
  effect: Effect.Effect<unknown, unknown>,
  signal: AbortSignal,
): Promise<boolean> {
  const exit = await Effect.runPromiseExit(effect, { signal });
  return Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause);
}

/** The tag and message of a typed failure. */
function failureOf<A>(result: Result.Result<A, PublicWebError>) {
  assert(Result.isFailure(result));
  return { tag: result.failure._tag, message: result.failure.message };
}

/** A response that never arrives; only an abort of the request ends the wait. */
async function neverResponds(): Promise<Response> {
  return new Promise<Response>(() => {
    // Never settles.
  });
}

const nestedCode = (code: unknown) =>
  new TypeError("fetch failed", { cause: new Error("inner", { cause: { code } }) });

describe("fetchPublicWebClient hop checks", () => {
  test("is interrupted by a signal aborted before the first hop", async () => {
    const { client, hops } = recordingClient(() => responseOf({ status: 200 }));
    await expect(wasInterrupted(client.get(makeRequest()), abortedSignal())).resolves.toBe(true);
    expect(hops).toHaveLength(0);
  });

  test("is interrupted before following a redirect when the caller aborts mid-chain", async () => {
    const controller = new AbortController();
    const { client, hops } = recordingClient(() => {
      controller.abort();
      return responseOf({ status: 302, headers: { location: "/next" } });
    });
    await expect(wasInterrupted(client.get(makeRequest()), controller.signal)).resolves.toBe(true);
    expect(hops).toHaveLength(1);
  });

  test("rejects URL credentials before the private-host check", async () => {
    const { client, hops } = recordingClient(() => responseOf({ status: 200 }));
    const url = unparsedUrl("http://user:secret@127.0.0.1/");
    const result = await run(client.get(makeRequest({ url })));
    expect(result).toStrictEqual(Result.fail(new UrlCredentialsUnsupported()));
    expect(hops).toHaveLength(0);
  });

  test("rejects a redirect to a URL with credentials", async () => {
    const { client, hops } = recordingClient(() =>
      responseOf({ status: 302, headers: { location: "https://user@example.com/" } }),
    );
    const result = await run(client.get(makeRequest({ blockPrivateHosts: false })));
    expect(result).toStrictEqual(Result.fail(new UrlCredentialsUnsupported()));
    expect(hops).toHaveLength(1);
  });

  test.each(["http://localhost:8080/", "http://api.LOCALHOST/"])(
    "blocks the localhost name in %s",
    async (url) => {
      const { client, hops } = recordingClient(() => responseOf({ status: 200 }));
      const result = await run(client.get(makeRequest({ url: publicUrl(url) })));
      expect(result).toStrictEqual(Result.fail(new PrivateHostBlocked()));
      expect(hops).toHaveLength(0);
    },
  );

  test("skips host checks when blockPrivateHosts is false", async () => {
    let lookups = 0;
    const { client, hops } = recordingClient(
      () => responseOf({ status: 200, body: "local" }),
      async () => {
        lookups += 1;
        return [{ address: "10.0.0.1" }];
      },
    );
    const url = publicUrl("http://127.0.0.1/");
    const result = await run(client.get(makeRequest({ url, blockPrivateHosts: false })));
    expect(result._tag).toBe("Success");
    expect(hops).toHaveLength(1);
    expect(lookups).toBe(0);
  });

  test("leaves a failed DNS lookup for the fetch to report", async () => {
    const { client, hops } = recordingClient(
      () => responseOf({ status: 200 }),
      async () => {
        throw new Error("ENOTFOUND");
      },
    );
    const result = await run(client.get(makeRequest()));
    expect(result._tag).toBe("Success");
    expect(hops).toHaveLength(1);
  });
});

describe("fetchPublicWebClient fetch failures", () => {
  const cases: readonly {
    readonly name: string;
    readonly cause: unknown;
    readonly message: string;
  }[] = [
    {
      name: "a bare network error",
      cause: new TypeError("fetch failed"),
      message: "Request to example.com failed",
    },
    {
      // fetch() itself never aborts unless the effect is interrupted, so a stray AbortError is
      // just a failed request.
      name: "a stray AbortError",
      cause: new DOMException("aborted", "AbortError"),
      message: "Request to example.com failed",
    },
    {
      name: "a DNS failure nested in the cause",
      cause: new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }),
      }),
      message: "Could not resolve host example.com",
    },
  ];

  test.each(cases)("maps $name to PublicWebRequestFailed", async ({ cause, message }) => {
    const { client } = recordingClient(() => {
      throw cause;
    });
    const result = await run(
      client.get(makeRequest({ url: publicUrl("https://example.com/a?key=secret") })),
    );
    expect(failureOf(result)).toStrictEqual({ tag: "PublicWebRequestFailed", message });
  });

  test("a caller deadline interrupts a hanging fetch and aborts its signal", async () => {
    const inits: (RequestInit | undefined)[] = [];
    const client = new FetchPublicWebClient({
      lookup: async () => [],
      fetchImpl: async (_input, init) => {
        inits.push(init);
        return neverResponds();
      },
    });
    const result = await run(client.get(makeRequest()).pipe(Effect.timeout("20 millis")));
    assert(Result.isFailure(result));
    expect(result.failure._tag).toBe("TimeoutError");
    expect(inits[0]?.signal?.aborted).toBe(true);
  });
});

describe("describeNetworkFailure", () => {
  test.each([
    ["ENOTFOUND", "Could not resolve host h.example"],
    ["EAI_AGAIN", "Could not resolve host h.example"],
    ["ECONNREFUSED", "Connection refused by h.example"],
    ["ECONNRESET", "Connection reset by h.example"],
    ["UND_ERR_SOCKET", "Connection reset by h.example"],
    ["ETIMEDOUT", "Connection to h.example timed out"],
    ["UND_ERR_CONNECT_TIMEOUT", "Connection to h.example timed out"],
    ["CERT_HAS_EXPIRED", "TLS certificate error for h.example (CERT_HAS_EXPIRED)"],
    [
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "TLS certificate error for h.example (ERR_TLS_CERT_ALTNAME_INVALID)",
    ],
    [
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "TLS certificate error for h.example (UNABLE_TO_VERIFY_LEAF_SIGNATURE)",
    ],
    [
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "TLS certificate error for h.example (DEPTH_ZERO_SELF_SIGNED_CERT)",
    ],
    [
      "SELF_SIGNED_CERT_IN_CHAIN",
      "TLS certificate error for h.example (SELF_SIGNED_CERT_IN_CHAIN)",
    ],
    ["EWHATEVER", "Request to h.example failed"],
    [42, "Request to h.example failed"],
  ])("describes code %s found two levels deep", (code, message) => {
    expect(describeNetworkFailure(nestedCode(code), "h.example")).toBe(message);
  });

  test("reads a code on the top-level error", () => {
    expect(describeNetworkFailure({ code: "ECONNREFUSED" }, "h.example")).toBe(
      "Connection refused by h.example",
    );
  });

  test("keeps walking past an unrecognised code to a recognised one", () => {
    const cause = Object.assign(new Error("outer", { cause: { code: "ENOTFOUND" } }), {
      code: "ERR_UNKNOWN",
    });
    expect(describeNetworkFailure(cause, "h.example")).toBe("Could not resolve host h.example");
  });

  test.each([undefined, null, "ENOTFOUND", 7])(
    "falls back for the non-object cause %j",
    (cause) => {
      expect(describeNetworkFailure(cause, "h.example")).toBe("Request to h.example failed");
    },
  );
});

describe("fetchPublicWebClient redirects", () => {
  test.each([301, 302, 303, 307, 308])(
    "follows a relative %s redirect, cancelling its body",
    async (status) => {
      const redirect = trackedResponse({ status, headers: { location: "/next?page=2" } });
      const { client, hops } = recordingClient(
        inOrder(
          () => redirect.response,
          () => responseOf({ status: 200, body: "done" }),
        ),
      );
      const result = await run(client.get(makeRequest()));
      assert(Result.isSuccess(result));
      expect(result.success.requestedUrl).toBe("https://example.com/");
      expect(result.success.finalUrl).toBe("https://example.com/next?page=2");
      expect(result.success.body.toString()).toBe("done");
      expect(redirect.wasCancelled()).toBe(true);
      expect(hops.map((hop) => hop.url)).toStrictEqual([
        "https://example.com/",
        "https://example.com/next?page=2",
      ]);
      expect(hops.map((hop) => hop.init?.redirect)).toStrictEqual(["manual", "manual"]);
    },
  );

  test("does not follow other 3xx statuses", async () => {
    const { client, hops } = recordingClient(() =>
      responseOf({ status: 300, headers: { location: "/elsewhere" } }),
    );
    const result = await run(client.get(makeRequest()));
    expect(result).toStrictEqual(
      Result.fail(new HttpStatusRejected({ status: 300, statusText: "" })),
    );
    expect(hops).toHaveLength(1);
  });

  test("reports a missing Location before the redirect limit, cancelling the body", async () => {
    const redirect = trackedResponse({ status: 302 });
    const { client } = recordingClient(() => redirect.response);
    const result = await run(client.get(makeRequest({ maxRedirects: 0 })));
    expect(result).toStrictEqual(Result.fail(new RedirectLocationMissing()));
    expect(redirect.wasCancelled()).toBe(true);
  });

  test("applies the redirect limit before parsing Location", async () => {
    const { client } = recordingClient(() =>
      responseOf({ status: 302, headers: { location: "http://[" } }),
    );
    const result = await run(client.get(makeRequest({ maxRedirects: 0 })));
    expect(result).toStrictEqual(Result.fail(new RedirectLimitExceeded({ maxRedirects: 0 })));
  });

  test("rejects an unparseable Location", async () => {
    const { client } = recordingClient(() =>
      responseOf({ status: 302, headers: { location: "http://[" } }),
    );
    const result = await run(client.get(makeRequest()));
    expect(result).toStrictEqual(Result.fail(new RedirectLocationInvalid()));
  });

  test("reports the unsupported redirect protocol", async () => {
    const { client } = recordingClient(() =>
      responseOf({ status: 307, headers: { location: "ftp://example.com/file" } }),
    );
    const result = await run(client.get(makeRequest()));
    expect(result).toStrictEqual(
      Result.fail(new RedirectProtocolUnsupported({ protocol: "ftp:" })),
    );
  });
});

describe("fetchPublicWebClient challenge retry", () => {
  const challenge = { status: 403, headers: { "cf-mitigated": "challenge" } };

  test("cancels the challenge body and retries only once", async () => {
    const first = trackedResponse(challenge);
    const { client, hops } = recordingClient(
      inOrder(
        () => first.response,
        () => responseOf(challenge),
      ),
    );
    const result = await run(client.get(makeRequest()));
    expect(result).toStrictEqual(
      Result.fail(new HttpStatusRejected({ status: 403, statusText: "" })),
    );
    expect(first.wasCancelled()).toBe(true);
    expect(hops.map((hop) => new Headers(hop.init?.headers).get("user-agent"))).toStrictEqual([
      "test-agent",
      "fallback-agent",
    ]);
  });

  test("returns the retry's failure", async () => {
    const { client, hops } = recordingClient(
      inOrder(
        () => responseOf(challenge),
        () => {
          throw new TypeError("fetch failed");
        },
      ),
    );
    const result = await run(client.get(makeRequest()));
    expect(failureOf(result)).toStrictEqual({
      tag: "PublicWebRequestFailed",
      message: "Request to example.com failed",
    });
    expect(hops).toHaveLength(2);
  });

  test("does not retry a 403 without the challenge header", async () => {
    const { client, hops } = recordingClient(() =>
      responseOf({ status: 403, headers: { "cf-mitigated": "block" } }),
    );
    const result = await run(client.get(makeRequest()));
    expect(result._tag).toBe("Failure");
    expect(hops).toHaveLength(1);
  });
});

describe("fetchPublicWebClient response body", () => {
  test("cancels the body of a rejected status", async () => {
    const rejected = trackedResponse({ status: 503 });
    const { client } = recordingClient(() => rejected.response);
    const result = await run(client.get(makeRequest()));
    expect(result._tag).toBe("Failure");
    expect(rejected.wasCancelled()).toBe(true);
  });

  test("cancels the body when Content-Length declares more than the cap", async () => {
    const oversized = trackedResponse({ status: 200, headers: { "content-length": "2048" } });
    const { client } = recordingClient(() => oversized.response);
    const result = await run(client.get(makeRequest({ maxResponseBytes: 1024 })));
    expect(result).toStrictEqual(Result.fail(new ResponseTooLarge({ maxBytes: 1024 })));
    expect(oversized.wasCancelled()).toBe(true);
  });

  test("reads the body when Content-Length is not a number", async () => {
    const { client } = recordingClient(() =>
      responseOf({ status: 200, body: "hello", headers: { "content-length": "many" } }),
    );
    const result = await run(client.get(makeRequest({ maxResponseBytes: 1024 })));
    assert(Result.isSuccess(result));
    expect(result.success.body.toString()).toBe("hello");
  });

  test("maps a streamed body over the cap to ResponseTooLarge", async () => {
    const streamed = trackedResponse(
      { status: 200 },
      {
        pull: (controller) => {
          controller.enqueue(new Uint8Array(2048));
        },
      },
    );
    const { client } = recordingClient(() => streamed.response);
    const result = await run(client.get(makeRequest({ maxResponseBytes: 1024 })));
    expect(result).toStrictEqual(Result.fail(new ResponseTooLarge({ maxBytes: 1024 })));
  });

  test("maps a failed body stream to PublicWebRequestFailed", async () => {
    const broken = trackedResponse(
      { status: 200 },
      {
        pull: (controller) => {
          controller.error(new Error("connection reset"));
        },
      },
    );
    const { client } = recordingClient(() => broken.response);
    const result = await run(client.get(makeRequest()));
    expect(failureOf(result)).toStrictEqual({
      tag: "PublicWebRequestFailed",
      message: "Request to example.com failed",
    });
  });

  test("a caller deadline during the body read cancels the body", async () => {
    // Without a pull source the body read never settles.
    const slow = trackedResponse({ status: 200 });
    const { client } = recordingClient(() => slow.response);
    const result = await run(client.get(makeRequest()).pipe(Effect.timeout("20 millis")));
    assert(Result.isFailure(result));
    expect(result.failure._tag).toBe("TimeoutError");
    expect(slow.wasCancelled()).toBe(true);
  });
});

describe("readResponseBodyWithLimit", () => {
  test("fails with ResponseBodyTooLarge and cancels the stream past the cap", async () => {
    const streamed = trackedResponse(
      { status: 200 },
      {
        pull: (controller) => {
          controller.enqueue(new Uint8Array(16));
        },
      },
    );
    const result = await run(readResponseBodyWithLimit(streamed.response, 8));
    assert(Result.isFailure(result));
    expect(result.failure).toBeInstanceOf(ResponseBodyTooLarge);
    expect(streamed.wasCancelled()).toBe(true);
  });

  test("fails with ResponseBodyReadFailed carrying the stream error for classification", async () => {
    const reset = new Error("connection reset");
    const broken = trackedResponse(
      { status: 200 },
      {
        pull: (controller) => {
          controller.error(reset);
        },
      },
    );
    const result = await run(readResponseBodyWithLimit(broken.response, 8));
    expect(result).toStrictEqual(Result.fail(new ResponseBodyReadFailed({ cause: reset })));
  });
});

describe("fetchPublicWebClient", () => {
  test("blocks private hostnames before any fetch", async () => {
    const { client, hops } = recordingClient(() => responseOf({ status: 200 }));
    const result = await run(client.get(makeRequest({ url: publicUrl("http://127.0.0.1/") })));
    assert(Result.isFailure(result));
    expect(result.failure._tag).toBe("PrivateIpBlocked");
    expect(hops).toHaveLength(0);
  });

  test("blocks hostnames resolving to private addresses", async () => {
    const { client } = recordingClient(
      () => responseOf({ status: 200 }),
      async () => [{ address: "93.184.216.34" }, { address: "10.4.4.4" }],
    );
    const result = await run(
      client.get(makeRequest({ url: publicUrl("https://sneaky.example/") })),
    );
    assert(Result.isFailure(result));
    expect(result.failure._tag).toBe("PrivateIpBlocked");
  });

  test("re-validates every redirect hop", async () => {
    const { client, hops } = recordingClient(
      inOrder(
        () => responseOf({ status: 302, headers: { location: "http://169.254.169.254/latest" } }),
        () => responseOf({ status: 200, body: "ok" }),
      ),
    );
    const result = await run(client.get(makeRequest({ url: publicUrl("https://start.example/") })));
    assert(Result.isFailure(result));
    expect(result.failure._tag).toBe("PrivateIpBlocked");
    expect(hops).toHaveLength(1);
  });

  test("caps redirect chains", async () => {
    const { client } = recordingClient(() =>
      responseOf({ status: 302, headers: { location: "https://example.com/loop" } }),
    );
    const result = await run(client.get(makeRequest({ maxRedirects: 2 })));
    assert(Result.isFailure(result));
    expect(result.failure._tag).toBe("RedirectLimitExceeded");
  });

  test("retries cloudflare challenges with the fallback user agent", async () => {
    const { client, hops } = recordingClient(
      inOrder(
        () => responseOf({ status: 403, headers: { "cf-mitigated": "challenge" } }),
        () => responseOf({ status: 200, body: "hello", headers: { "content-type": "text/plain" } }),
      ),
    );
    const result = await run(client.get(makeRequest()));
    expect(result._tag).toBe("Success");
    expect(hops.map((hop) => new Headers(hop.init?.headers).get("user-agent"))).toStrictEqual([
      "test-agent",
      "fallback-agent",
    ]);
  });
});
