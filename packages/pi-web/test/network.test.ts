import { assert, describe, expect, it, test } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import type { PublicWebError, PublicWebRequest } from "../network";
import {
  classifyMimeType,
  decodeTextBuffer,
  describeNetworkFailure,
  HttpStatusRejected,
  isPrivateOrLocalIp,
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
import { UTF8, publicUrl, publicWebClientWith } from "./fakes";

describe("isPrivateOrLocalIp", () => {
  // network-properties.test.ts covers the range tables generatively. These rows stay as the explicit
  // list of addresses the SSRF guard must classify, including febf::1 and fec0::1, which straddle the
  // fe80::/10 boundary and which the property's generator does not reach.
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
    "::FFFF:7F00:1",
    "0:0:0:0:0:ffff:127.0.0.1",
    "::8.8.8.8",
    "64:ff9b::a00:1",
    "64:ff9b::10.0.0.1",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
    "::ffff:224.0.0.1",
    "ff02::1",
    "ff0e::1",
    "febf::1",
    "64:ff9b:1::1",
    "192.0.0.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "2001:db8::1",
    "100::1",
    "2002:a00:1::",
    "2002:7f00:1::1",
    "::ffff:0:10.0.0.1",
    "0:0:0:0:0:0:ffff:ffff",
    "64:ff9b::ffff:ffff",
    "64:ff9b:1:ffff:ffff:ffff:ffff:ffff",
    "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
    "100::ffff:ffff:ffff:ffff",
    "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  ];

  test.each(blocked)("blocks %s", (ip) => {
    expect(isPrivateOrLocalIp(ip)).toBe(true);
  });

  const allowed = [
    "8.8.8.8",
    "1.1.1.1",
    "172.15.0.1",
    "198.20.0.1",
    "2002:808:808::1",
    "::ffff:0:8.8.8.8",
    "172.32.0.1",
    "100.63.0.1",
    "100.128.0.1",
    "2001:4860:4860::8888",
    "not-an-ip",
    "::ffff:8.8.8.8",
    "223.255.255.255",
    "fec0::1",
    "fc::1",
    "fe8::1",
    "::1:0:0",
    "64:ff9b:0:0:0:1:0:0",
    "2001:db9::",
    "100:0:0:1::",
    "fe00::",
    "fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  ];

  test.each(allowed)("allows %s", (ip) => {
    expect(isPrivateOrLocalIp(ip)).toBe(false);
  });
});

// An independent statement of the non-public ranges, written from the registries rather than read
// from network.ts. Each row yields both edges (first and last address inside, blocked) and both
// neighbours (allowed unless another row covers them).
const RANGES: readonly (readonly [cidr: string, purpose: string])[] = [
  ["0.0.0.0/8", "RFC 791 this network"],
  ["10.0.0.0/8", "RFC 1918 private use"],
  ["100.64.0.0/10", "RFC 6598 carrier-grade NAT"],
  ["127.0.0.0/8", "RFC 1122 loopback"],
  ["169.254.0.0/16", "RFC 3927 link-local"],
  ["172.16.0.0/12", "RFC 1918 private use"],
  ["192.168.0.0/16", "RFC 1918 private use"],
  ["224.0.0.0/4", "RFC 5771 multicast"],
  ["240.0.0.0/4", "RFC 1112 reserved and broadcast"],
  ["192.0.0.0/24", "RFC 6890 IETF protocol assignments"],
  ["192.0.2.0/24", "RFC 5737 TEST-NET-1"],
  ["198.18.0.0/15", "RFC 2544 benchmarking"],
  ["198.51.100.0/24", "RFC 5737 TEST-NET-2"],
  ["203.0.113.0/24", "RFC 5737 TEST-NET-3"],
  ["::/96", "RFC 4291 unspecified, loopback and deprecated IPv4-compatible"],
  ["64:ff9b::/96", "RFC 6052 NAT64 well-known prefix"],
  ["64:ff9b:1::/48", "RFC 8215 local-use NAT64"],
  ["2001:db8::/32", "RFC 3849 documentation"],
  ["100::/64", "RFC 6666 discard-only"],
  ["fc00::/7", "RFC 4193 unique local"],
  ["fe80::/10", "RFC 4291 link-local"],
  ["ff00::/8", "RFC 4291 multicast"],
];

type Cidr = { readonly v6: boolean; readonly first: bigint; readonly last: bigint };

const parseV4 = (text: string): bigint =>
  text.split(".").reduce((acc, part) => acc * 256n + BigInt(part), 0n);

function parseV6(text: string): bigint {
  const [head = "", tail = ""] = text.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === "" ? [] : tail.split(":");
  const fill = Array.from({ length: 8 - front.length - back.length }, () => "0");
  return [...front, ...fill, ...back].reduce(
    (acc, group) => (acc << 16n) | BigInt(`0x${group}`),
    0n,
  );
}

const formatV4 = (value: bigint): string =>
  [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 255n)).join(".");

const formatV6 = (value: bigint): string =>
  Array.from({ length: 8 }, (_, index) =>
    ((value >> BigInt(16 * (7 - index))) & 0xff_ffn).toString(16),
  ).join(":");

function parseCidr(text: string): Cidr {
  const [address = "", length = ""] = text.split("/");
  const v6 = address.includes(":");
  const first = v6 ? parseV6(address) : parseV4(address);
  return { v6, first, last: first + (1n << ((v6 ? 128n : 32n) - BigInt(length))) - 1n };
}

const PARSED_RANGES = RANGES.map(([cidr]) => parseCidr(cidr));

const covered = (v6: boolean, value: bigint): boolean =>
  PARSED_RANGES.some((range) => range.v6 === v6 && value >= range.first && value <= range.last);

/** [label, address, blocked] for the edges and neighbours of one range. */
function edgeCases(cidr: string): readonly (readonly [string, string, boolean])[] {
  const range = parseCidr(cidr);
  const format = range.v6 ? formatV6 : formatV4;
  const max = (1n << (range.v6 ? 128n : 32n)) - 1n;
  const cases: [string, string, boolean][] = [
    [`${cidr} first`, format(range.first), true],
    [`${cidr} last`, format(range.last), true],
  ];
  if (range.first > 0n) {
    const below = range.first - 1n;
    cases.push([`${cidr} below`, format(below), covered(range.v6, below)]);
  }
  if (range.last < max) {
    const above = range.last + 1n;
    cases.push([`${cidr} above`, format(above), covered(range.v6, above)]);
  }
  return cases;
}

describe("isPrivateOrLocalIp range edges", () => {
  test.each(RANGES.flatMap(([cidr]) => edgeCases(cidr)))("%s: %s", (_label, address, blocked) => {
    expect(isPrivateOrLocalIp(address)).toBe(blocked);
  });
});

describe("classifyMimeType", () => {
  // The MIME table, the text/ and +xml/+json suffix rules and the binary default are covered by
  // content-properties.test.ts. image/avif is the one decision the property does not generate.
  const cases = [["image/avif", "binary"]] as const;

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
    domainPolicy: { allow: [], deny: [] },
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

function recordingClient(
  respond: (url: string) => Response,
  lookup: () => Promise<readonly { address: string }[]> = async () => [
    { address: "93.184.216.34" },
  ],
) {
  const hops: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
  const fetchImpl: typeof fetch = async (input: unknown, init?: RequestInit) => {
    hops.push({ url: String(input), init });
    await Promise.resolve();
    return respond(String(input));
  };
  return { client: publicWebClientWith({ fetchImpl, lookup }), hops };
}

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

const redirectReply = () =>
  responseOf({ status: 302, headers: { location: "https://example.com/next" } });

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

async function run<A, E>(effect: Effect.Effect<A, E>): Promise<Result.Result<A, E>> {
  return Effect.runPromise(Effect.result(effect));
}

async function wasInterrupted(
  effect: Effect.Effect<unknown, unknown>,
  signal: AbortSignal,
): Promise<boolean> {
  const exit = await Effect.runPromiseExit(effect, { signal });
  return Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause);
}

function failureOf<A>(result: Result.Result<A, PublicWebError>) {
  assert(Result.isFailure(result));
  return { tag: result.failure._tag, message: result.failure.message };
}

async function neverResponds(): Promise<Response> {
  return Promise.withResolvers<Response>().promise;
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
    const request = { ...makeRequest(), url: "http://user:secret@127.0.0.1/" };
    const invocation: unknown = Reflect.apply(client.get, client, [request]);
    assert(Effect.isEffect(invocation));
    const execution: unknown = Reflect.apply(Effect.runPromise, undefined, [
      Effect.result(invocation),
    ]);
    assert(execution instanceof Promise);
    const result: unknown = await execution;
    expect(result).toStrictEqual(Result.fail(new UrlCredentialsUnsupported()));
    expect(hops).toHaveLength(0);
  });

  it.effect("rejects a redirect to a URL with credentials", () =>
    Effect.gen(function* () {
      const { client, hops } = recordingClient(() =>
        responseOf({ status: 302, headers: { location: "https://user@example.com/" } }),
      );
      const result = yield* Effect.result(client.get(makeRequest({ blockPrivateHosts: false })));
      expect(result).toStrictEqual(Result.fail(new UrlCredentialsUnsupported()));
      expect(hops).toHaveLength(1);
    }),
  );

  test.each(["http://localhost:8080/", "http://api.LOCALHOST/"])(
    "blocks the localhost name in %s",
    async (url) => {
      const { client, hops } = recordingClient(() => responseOf({ status: 200 }));
      const result = await run(client.get(makeRequest({ url: publicUrl(url) })));
      expect(result).toStrictEqual(Result.fail(new PrivateHostBlocked()));
      expect(hops).toHaveLength(0);
    },
  );

  it.effect("skips host checks when blockPrivateHosts is false", () =>
    Effect.gen(function* () {
      let lookups = 0;
      const { client, hops } = recordingClient(
        () => responseOf({ status: 200, body: "local" }),
        async () => {
          lookups += 1;
          return [{ address: "10.0.0.1" }];
        },
      );
      const url = publicUrl("http://127.0.0.1/");
      const result = yield* Effect.result(
        client.get(makeRequest({ url, blockPrivateHosts: false })),
      );
      expect(result._tag).toBe("Success");
      expect(hops).toHaveLength(1);
      expect(lookups).toBe(0);
    }),
  );

  it.effect("fails closed when DNS resolution rejects", () =>
    Effect.gen(function* () {
      const { client, hops } = recordingClient(
        () => responseOf({ status: 200 }),
        async () => {
          throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
        },
      );
      const result = yield* Effect.result(client.get(makeRequest()));
      expect(failureOf(result)).toStrictEqual({
        tag: "PublicWebRequestFailed",
        message: "Could not resolve host example.com",
      });
      expect(hops).toHaveLength(0);
    }),
  );

  it.effect("fails closed when DNS resolution returns no addresses", () =>
    Effect.gen(function* () {
      const { client, hops } = recordingClient(
        () => responseOf({ status: 200 }),
        async () => [],
      );
      const result = yield* Effect.result(client.get(makeRequest()));
      expect(failureOf(result)).toStrictEqual({
        tag: "PublicWebRequestFailed",
        message: "Could not resolve host example.com",
      });
      expect(hops).toHaveLength(0);
    }),
  );
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

  it.effect("a caller deadline interrupts a hanging fetch and aborts its signal", () =>
    Effect.gen(function* () {
      const fetchStarted = Promise.withResolvers<undefined>();
      const inits: (RequestInit | undefined)[] = [];
      const client = publicWebClientWith({
        lookup: async () => [{ address: "93.184.216.34" }],
        fetchImpl: async (_input, init) => {
          inits.push(init);
          fetchStarted.resolve(undefined);
          return neverResponds();
        },
      });
      const fiber = yield* Effect.forkChild(
        Effect.result(client.get(makeRequest()).pipe(Effect.timeout("20 millis"))),
      );
      // The deadline is the test clock's, and only moves once the fetch is hanging.
      yield* Effect.promise(async () => fetchStarted.promise);
      yield* TestClock.adjust("20 millis");
      const result = yield* Fiber.join(fiber);
      assert(Result.isFailure(result));
      expect(result.failure._tag).toBe("TimeoutError");
      expect(inits[0]?.signal?.aborted).toBe(true);
    }),
  );
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

  it.effect("does not follow other 3xx statuses", () =>
    Effect.gen(function* () {
      const { client, hops } = recordingClient(() =>
        responseOf({ status: 300, headers: { location: "/elsewhere" } }),
      );
      const result = yield* Effect.result(client.get(makeRequest()));
      expect(result).toStrictEqual(
        Result.fail(new HttpStatusRejected({ status: 300, statusText: "" })),
      );
      expect(hops).toHaveLength(1);
    }),
  );

  it.effect("reports a missing Location before the redirect limit, cancelling the body", () =>
    Effect.gen(function* () {
      const redirect = trackedResponse({ status: 302 });
      const { client } = recordingClient(() => redirect.response);
      const result = yield* Effect.result(client.get(makeRequest({ maxRedirects: 0 })));
      expect(result).toStrictEqual(Result.fail(new RedirectLocationMissing()));
      expect(redirect.wasCancelled()).toBe(true);
    }),
  );

  it.effect("applies the redirect limit before parsing Location", () =>
    Effect.gen(function* () {
      const { client } = recordingClient(() =>
        responseOf({ status: 302, headers: { location: "http://[" } }),
      );
      const result = yield* Effect.result(client.get(makeRequest({ maxRedirects: 0 })));
      expect(result).toStrictEqual(Result.fail(new RedirectLimitExceeded({ maxRedirects: 0 })));
    }),
  );

  it.effect("rejects an unparseable Location", () =>
    Effect.gen(function* () {
      const { client } = recordingClient(() =>
        responseOf({ status: 302, headers: { location: "http://[" } }),
      );
      const result = yield* Effect.result(client.get(makeRequest()));
      expect(result).toStrictEqual(Result.fail(new RedirectLocationInvalid()));
    }),
  );

  it.effect("reports the unsupported redirect protocol", () =>
    Effect.gen(function* () {
      const { client } = recordingClient(() =>
        responseOf({ status: 307, headers: { location: "ftp://example.com/file" } }),
      );
      const result = yield* Effect.result(client.get(makeRequest()));
      expect(result).toStrictEqual(
        Result.fail(new RedirectProtocolUnsupported({ protocol: "ftp:" })),
      );
    }),
  );

  test.each([
    {
      name: "denied",
      policy: { allow: [], deny: ["blocked.example"] },
      destination: "https://blocked.example/secret",
      tag: "DomainDenied",
    },
    {
      name: "unlisted",
      policy: { allow: ["example.com"], deny: [] },
      destination: "https://unlisted.example/secret",
      tag: "DomainNotAllowed",
    },
  ])("rejects a $name redirect before requesting its destination", async (testCase) => {
    const { client, hops } = recordingClient(
      inOrder(
        () => responseOf({ status: 302, headers: { location: testCase.destination } }),
        () => responseOf({ status: 200, body: "must not be reached" }),
      ),
    );
    const result = await run(client.get(makeRequest({ domainPolicy: testCase.policy })));
    assert(Result.isFailure(result));
    expect(result.failure._tag).toBe(testCase.tag);
    expect(hops.map((hop) => hop.url)).toStrictEqual(["https://example.com/"]);
  });
});

describe("fetchPublicWebClient challenge retry", () => {
  const challenge = { status: 403, headers: { "cf-mitigated": "challenge" } };

  it.effect("cancels the challenge body and retries only once", () =>
    Effect.gen(function* () {
      const first = trackedResponse(challenge);
      const { client, hops } = recordingClient(
        inOrder(
          () => first.response,
          () => responseOf(challenge),
        ),
      );
      const result = yield* Effect.result(client.get(makeRequest()));
      expect(result).toStrictEqual(
        Result.fail(new HttpStatusRejected({ status: 403, statusText: "" })),
      );
      expect(first.wasCancelled()).toBe(true);
      expect(hops.map((hop) => new Headers(hop.init?.headers).get("user-agent"))).toStrictEqual([
        "test-agent",
        "fallback-agent",
      ]);
    }),
  );

  it.effect("returns the retry's failure", () =>
    Effect.gen(function* () {
      const { client, hops } = recordingClient(
        inOrder(
          () => responseOf(challenge),
          () => {
            throw new TypeError("fetch failed");
          },
        ),
      );
      const result = yield* Effect.result(client.get(makeRequest()));
      expect(failureOf(result)).toStrictEqual({
        tag: "PublicWebRequestFailed",
        message: "Request to example.com failed",
      });
      expect(hops).toHaveLength(2);
    }),
  );

  it.effect("does not retry a 403 without the challenge header", () =>
    Effect.gen(function* () {
      const { client, hops } = recordingClient(() =>
        responseOf({ status: 403, headers: { "cf-mitigated": "block" } }),
      );
      const result = yield* Effect.result(client.get(makeRequest()));
      expect(result._tag).toBe("Failure");
      expect(hops).toHaveLength(1);
    }),
  );
});

describe("fetchPublicWebClient response body", () => {
  it.effect("cancels the body of a rejected status", () =>
    Effect.gen(function* () {
      const rejected = trackedResponse({ status: 503 });
      const { client } = recordingClient(() => rejected.response);
      const result = yield* Effect.result(client.get(makeRequest()));
      expect(result._tag).toBe("Failure");
      expect(rejected.wasCancelled()).toBe(true);
    }),
  );

  it.effect("cancels the body when Content-Length declares more than the cap", () =>
    Effect.gen(function* () {
      const oversized = trackedResponse({ status: 200, headers: { "content-length": "2048" } });
      const { client } = recordingClient(() => oversized.response);
      const result = yield* Effect.result(client.get(makeRequest({ maxResponseBytes: 1024 })));
      expect(result).toStrictEqual(Result.fail(new ResponseTooLarge({ maxBytes: 1024 })));
      expect(oversized.wasCancelled()).toBe(true);
    }),
  );

  it.effect("accepts a Content-Length exactly at the cap and rejects one byte over", () =>
    Effect.gen(function* () {
      const exact = recordingClient(() =>
        responseOf({ status: 200, body: "x".repeat(1024), headers: { "content-length": "1024" } }),
      );
      const accepted = yield* Effect.result(
        exact.client.get(makeRequest({ maxResponseBytes: 1024 })),
      );
      assert(Result.isSuccess(accepted));
      expect(accepted.success.body.byteLength).toBe(1024);

      const over = trackedResponse({ status: 200, headers: { "content-length": "1025" } });
      const rejected = yield* Effect.result(
        recordingClient(() => over.response).client.get(makeRequest({ maxResponseBytes: 1024 })),
      );
      expect(rejected).toStrictEqual(Result.fail(new ResponseTooLarge({ maxBytes: 1024 })));
      expect(over.wasCancelled()).toBe(true);
    }),
  );

  it.effect("returns the first bytes of a body over the cap when partial text is allowed", () =>
    Effect.gen(function* () {
      const streamed = trackedResponse(
        { status: 200, headers: { "content-type": "text/plain" } },
        {
          pull: (controller) => {
            controller.enqueue(new TextEncoder().encode("abcdefgh"));
          },
        },
      );
      const { client } = recordingClient(() => streamed.response);
      const result = yield* Effect.result(
        client.get(makeRequest({ maxResponseBytes: 12, allowPartialText: true })),
      );
      assert(Result.isSuccess(result));
      expect(result.success.body.toString()).toBe("abcdefghabcd");
      expect(result.success.responseTruncated).toBe(true);
      expect(streamed.wasCancelled()).toBe(true);
    }),
  );

  it.effect("reads to the cap instead of failing on an over-cap Content-Length", () =>
    Effect.gen(function* () {
      const { client } = recordingClient(() =>
        responseOf({
          status: 200,
          body: "x".repeat(2048),
          headers: { "content-type": "text/html", "content-length": "2048" },
        }),
      );
      const result = yield* Effect.result(
        client.get(makeRequest({ maxResponseBytes: 1024, allowPartialText: true })),
      );
      assert(Result.isSuccess(result));
      expect(result.success.body.byteLength).toBe(1024);
      expect(result.success.responseTruncated).toBe(true);
    }),
  );

  it.effect("keeps failing an oversized image even when partial text is allowed", () =>
    Effect.gen(function* () {
      const declared = recordingClient(() =>
        responseOf({
          status: 200,
          headers: { "content-type": "image/png", "content-length": "2048" },
        }),
      );
      const head = yield* Effect.result(
        declared.client.get(makeRequest({ maxResponseBytes: 1024, allowPartialText: true })),
      );
      expect(head).toStrictEqual(Result.fail(new ResponseTooLarge({ maxBytes: 1024 })));

      const streamed = recordingClient(() =>
        responseOf({
          status: 200,
          body: "x".repeat(2048),
          headers: { "content-type": "image/png" },
        }),
      );
      const body = yield* Effect.result(
        streamed.client.get(makeRequest({ maxResponseBytes: 1024, allowPartialText: true })),
      );
      expect(body).toStrictEqual(Result.fail(new ResponseTooLarge({ maxBytes: 1024 })));
    }),
  );

  it.effect("reads the body when Content-Length is not a number", () =>
    Effect.gen(function* () {
      const { client } = recordingClient(() =>
        responseOf({ status: 200, body: "hello", headers: { "content-length": "many" } }),
      );
      const result = yield* Effect.result(client.get(makeRequest({ maxResponseBytes: 1024 })));
      assert(Result.isSuccess(result));
      expect(result.success.body.toString()).toBe("hello");
    }),
  );

  it.effect("maps a streamed body over the cap to ResponseTooLarge", () =>
    Effect.gen(function* () {
      const streamed = trackedResponse(
        { status: 200 },
        {
          pull: (controller) => {
            controller.enqueue(new Uint8Array(2048));
          },
        },
      );
      const { client } = recordingClient(() => streamed.response);
      const result = yield* Effect.result(client.get(makeRequest({ maxResponseBytes: 1024 })));
      expect(result).toStrictEqual(Result.fail(new ResponseTooLarge({ maxBytes: 1024 })));
    }),
  );

  it.effect("maps a failed body stream to PublicWebRequestFailed", () =>
    Effect.gen(function* () {
      const broken = trackedResponse(
        { status: 200 },
        {
          pull: (controller) => {
            controller.error(new Error("connection reset"));
          },
        },
      );
      const { client } = recordingClient(() => broken.response);
      const result = yield* Effect.result(client.get(makeRequest()));
      expect(failureOf(result)).toStrictEqual({
        tag: "PublicWebRequestFailed",
        message: "Request to example.com failed",
      });
    }),
  );

  it.effect("a caller deadline during the body read cancels the body", () =>
    Effect.gen(function* () {
      const bodyRead = Promise.withResolvers<undefined>();
      const slow = trackedResponse(
        { status: 200 },
        {
          pull: () => {
            bodyRead.resolve(undefined);
          },
        },
      );
      const { client } = recordingClient(() => slow.response);
      const fiber = yield* Effect.forkChild(
        Effect.result(client.get(makeRequest()).pipe(Effect.timeout("20 millis"))),
      );
      // The deadline is the test clock's, and only moves once the body read is pending.
      yield* Effect.promise(async () => bodyRead.promise);
      yield* TestClock.adjust("20 millis");
      const result = yield* Fiber.join(fiber);
      assert(Result.isFailure(result));
      expect(result.failure._tag).toBe("TimeoutError");
      expect(slow.wasCancelled()).toBe(true);
    }),
  );
});

describe("readResponseBodyWithLimit", () => {
  it.effect("fails with ResponseBodyTooLarge and cancels the stream past the cap", () =>
    Effect.gen(function* () {
      const streamed = trackedResponse(
        { status: 200 },
        {
          pull: (controller) => {
            controller.enqueue(new Uint8Array(16));
          },
        },
      );
      const result = yield* Effect.result(readResponseBodyWithLimit(streamed.response, 8));
      assert(Result.isFailure(result));
      expect(result.failure).toBeInstanceOf(ResponseBodyTooLarge);
      expect(streamed.wasCancelled()).toBe(true);
    }),
  );

  it.effect("fails with ResponseBodyReadFailed carrying the stream error for classification", () =>
    Effect.gen(function* () {
      const reset = new Error("connection reset");
      const broken = trackedResponse(
        { status: 200 },
        {
          pull: (controller) => {
            controller.error(reset);
          },
        },
      );
      const result = yield* Effect.result(readResponseBodyWithLimit(broken.response, 8));
      expect(result).toStrictEqual(Result.fail(new ResponseBodyReadFailed({ cause: reset })));
    }),
  );
});

describe("fetchPublicWebClient", () => {
  it.effect("blocks private hostnames before any fetch", () =>
    Effect.gen(function* () {
      const { client, hops } = recordingClient(() => responseOf({ status: 200 }));
      const result = yield* Effect.result(
        client.get(makeRequest({ url: publicUrl("http://127.0.0.1/") })),
      );
      assert(Result.isFailure(result));
      expect(result.failure._tag).toBe("PrivateIpBlocked");
      expect(hops).toHaveLength(0);
    }),
  );

  it.effect("blocks hostnames resolving to private addresses", () =>
    Effect.gen(function* () {
      const { client } = recordingClient(
        () => responseOf({ status: 200 }),
        async () => [{ address: "93.184.216.34" }, { address: "10.4.4.4" }],
      );
      const result = yield* Effect.result(
        client.get(makeRequest({ url: publicUrl("https://sneaky.example/") })),
      );
      assert(Result.isFailure(result));
      expect(result.failure._tag).toBe("PrivateIpBlocked");
    }),
  );

  it.effect("re-validates every redirect hop", () =>
    Effect.gen(function* () {
      const { client, hops } = recordingClient(
        inOrder(
          () => responseOf({ status: 302, headers: { location: "http://169.254.169.254/latest" } }),
          () => responseOf({ status: 200, body: "ok" }),
        ),
      );
      const result = yield* Effect.result(
        client.get(makeRequest({ url: publicUrl("https://start.example/") })),
      );
      assert(Result.isFailure(result));
      expect(result.failure._tag).toBe("PrivateIpBlocked");
      expect(hops).toHaveLength(1);
    }),
  );

  it.effect("caps redirect chains", () =>
    Effect.gen(function* () {
      const { client } = recordingClient(() =>
        responseOf({ status: 302, headers: { location: "https://example.com/loop" } }),
      );
      const result = yield* Effect.result(client.get(makeRequest({ maxRedirects: 2 })));
      assert(Result.isFailure(result));
      expect(result.failure._tag).toBe("RedirectLimitExceeded");
    }),
  );

  it.effect("follows exactly maxRedirects redirects, then fails on the next one", () =>
    Effect.gen(function* () {
      const atLimit = recordingClient(
        inOrder(redirectReply, redirectReply, () => responseOf({ status: 200 })),
      );
      const reached = yield* Effect.result(atLimit.client.get(makeRequest({ maxRedirects: 2 })));
      assert(Result.isSuccess(reached));
      expect(reached.success.status).toBe(200);
      expect(atLimit.hops).toHaveLength(3);

      const overLimit = recordingClient(
        inOrder(redirectReply, redirectReply, redirectReply, () => responseOf({ status: 200 })),
      );
      const refused = yield* Effect.result(overLimit.client.get(makeRequest({ maxRedirects: 2 })));
      expect(refused).toStrictEqual(Result.fail(new RedirectLimitExceeded({ maxRedirects: 2 })));
      expect(overLimit.hops).toHaveLength(3);
    }),
  );

  it.effect("retries cloudflare challenges with the fallback user agent", () =>
    Effect.gen(function* () {
      const { client, hops } = recordingClient(
        inOrder(
          () => responseOf({ status: 403, headers: { "cf-mitigated": "challenge" } }),
          () =>
            responseOf({ status: 200, body: "hello", headers: { "content-type": "text/plain" } }),
        ),
      );
      const result = yield* Effect.result(client.get(makeRequest()));
      expect(result._tag).toBe("Success");
      expect(hops.map((hop) => new Headers(hop.init?.headers).get("user-agent"))).toStrictEqual([
        "test-agent",
        "fallback-agent",
      ]);
    }),
  );
});
