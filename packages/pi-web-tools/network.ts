import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Context, Effect, Layer, Schema } from "effect";
import { absurd } from "effect/Function";
import { isPublicHttpUrl } from "./types";
import type { ContentKind, PublicHttpUrl } from "./types";

// Exact mime types, checked before the suffix rules in classifyMimeType. Types those rules already
// classify as text (application/ld+json, application/atom+xml, ...) need no entry.
const MIME_KINDS: ReadonlyMap<string, ContentKind> = new Map<string, ContentKind>([
  ["text/html", "html"],
  ["application/xhtml+xml", "html"],
  ["image/png", "raster-image"],
  ["image/jpeg", "raster-image"],
  ["image/gif", "raster-image"],
  ["image/webp", "raster-image"],
  ["image/svg+xml", "svg"],
  ["application/json", "text"],
  ["application/xml", "text"],
  ["application/javascript", "text"],
  ["application/x-javascript", "text"],
  ["application/ecmascript", "text"],
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// The WHATWG name of UTF-8: TextDecoder reports it, and webfetch details show it as the decoder.
const UTF8_LABEL = "utf-8";
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const LEADING_DIGITS_RE = /^\d+/u;

/** A parsed Content-Type header. */
export type ParsedContentType = {
  readonly contentType: string;
  readonly mime: string;
  readonly charset?: string | undefined;
  readonly kind: ContentKind;
};

/** A single outbound public web request. */
export type PublicWebRequest = {
  readonly url: PublicHttpUrl;
  readonly accept: string;
  readonly userAgent: string;
  readonly fallbackUserAgent: string;
  readonly maxRedirects: number;
  readonly maxResponseBytes: number;
  readonly blockPrivateHosts: boolean;
};

/** A bounded public web response. */
export type PublicWebResponse = {
  readonly requestedUrl: PublicHttpUrl;
  readonly finalUrl: PublicHttpUrl;
  readonly status: number;
  readonly headers: Headers;
  readonly body: Readonly<Buffer>;
};

/** A request could not be completed at the network level (DNS, connection, TLS, or body stream). */
export class PublicWebRequestFailed extends Schema.TaggedError<PublicWebRequestFailed>()(
  "PublicWebRequestFailed",
  {
    /** The host the failing request was sent to; messages name only this, never the URL. */
    hostname: Schema.String,
    /** The underlying fetch or stream error, kept for local diagnosis only. */
    cause: Schema.optional(Schema.Defect()),
  },
) {
  /** Safe description of the network failure, for example "Could not resolve host example.com". */
  override get message(): string {
    return describeNetworkFailure(this.cause, this.hostname);
  }
}

/** The URL resolved to localhost or a *.localhost name. */
export class PrivateHostBlocked extends Schema.TaggedError<PrivateHostBlocked>()(
  "PrivateHostBlocked",
  {},
) {
  /** Safe user-facing description. */
  override get message(): string {
    return "Blocked private or local host";
  }
}

/** The URL is, or resolves to, a non-public IP address. */
export class PrivateIpBlocked extends Schema.TaggedError<PrivateIpBlocked>()(
  "PrivateIpBlocked",
  {},
) {
  /** Safe user-facing description. */
  override get message(): string {
    return "Blocked private or local IP address";
  }
}

/** The requested URL or a redirect target carries user:password credentials. */
export class UrlCredentialsUnsupported extends Schema.TaggedError<UrlCredentialsUnsupported>()(
  "UrlCredentialsUnsupported",
  {},
) {
  /** Safe user-facing description. */
  override get message(): string {
    return "URL credentials are not supported";
  }
}

/** A redirect response had no Location header. */
export class RedirectLocationMissing extends Schema.TaggedError<RedirectLocationMissing>()(
  "RedirectLocationMissing",
  {},
) {
  /** Safe user-facing description. */
  override get message(): string {
    return "Redirect response was missing a Location header";
  }
}

/** A redirect Location header did not parse as a public URL. */
export class RedirectLocationInvalid extends Schema.TaggedError<RedirectLocationInvalid>()(
  "RedirectLocationInvalid",
  {},
) {
  /** Safe user-facing description. */
  override get message(): string {
    return "Redirect response had an invalid Location header";
  }
}

/** The redirect chain exceeded the configured hop limit. */
export class RedirectLimitExceeded extends Schema.TaggedError<RedirectLimitExceeded>()(
  "RedirectLimitExceeded",
  {
    /** The configured hop limit. */
    maxRedirects: Schema.Number,
  },
) {
  /** Safe user-facing description. */
  override get message(): string {
    return "Too many redirects while fetching URL";
  }
}

/** A redirect pointed at a non-http(s) protocol. */
export class RedirectProtocolUnsupported extends Schema.TaggedError<RedirectProtocolUnsupported>()(
  "RedirectProtocolUnsupported",
  {
    /** The rejected protocol, for example "ftp:". */
    protocol: Schema.String,
  },
) {
  /** Safe user-facing description. */
  override get message(): string {
    return "Redirected to unsupported protocol";
  }
}

/** The final response had a non-2xx status. */
export class HttpStatusRejected extends Schema.TaggedError<HttpStatusRejected>()(
  "HttpStatusRejected",
  {
    /** The HTTP status code. */
    status: Schema.Number,
    /** The HTTP status text, possibly empty. */
    statusText: Schema.String,
  },
) {
  /** Safe user-facing description with the status. */
  override get message(): string {
    return `Request failed (${this.status}${this.statusText ? ` ${this.statusText}` : ""})`;
  }
}

/** The response declared or streamed more bytes than the cap allows. */
export class ResponseTooLarge extends Schema.TaggedError<ResponseTooLarge>()("ResponseTooLarge", {
  /** The byte cap that was exceeded. */
  maxBytes: Schema.Number,
}) {
  /** Safe user-facing description with the cap in MB. */
  override get message(): string {
    return `Response too large (${Math.floor(this.maxBytes / (1024 * 1024))}MB limit)`;
  }
}

/** Expected failures of the public web client. Their messages never contain URLs or causes. */
export type PublicWebError =
  | PublicWebRequestFailed
  | PrivateHostBlocked
  | PrivateIpBlocked
  | UrlCredentialsUnsupported
  | RedirectLocationMissing
  | RedirectLocationInvalid
  | RedirectLimitExceeded
  | RedirectProtocolUnsupported
  | HttpStatusRejected
  | ResponseTooLarge;

/** Network error codes, as Node and undici report them, grouped by what they mean for the user. */
const NETWORK_CODE_KINDS: ReadonlyMap<string, "dns" | "refused" | "reset" | "timeout" | "tls"> =
  new Map([
    ["ENOTFOUND", "dns"],
    ["EAI_AGAIN", "dns"],
    ["ECONNREFUSED", "refused"],
    ["ECONNRESET", "reset"],
    ["UND_ERR_SOCKET", "reset"],
    ["ETIMEDOUT", "timeout"],
    ["UND_ERR_CONNECT_TIMEOUT", "timeout"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "tls"],
  ]);
/** How deep to follow `cause` links; real fetch errors nest two or three levels. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Describe a failed network request from its error's `cause` chain, naming only the host.
 * fetch rejects with a generic TypeError whose `cause` (or a deeper one) carries the system code.
 *
 * @param cause - The fetch or stream rejection.
 * @param hostname - The host the request was sent to.
 * @returns A sentence such as "Could not resolve host example.com".
 */
export function describeNetworkFailure(cause: unknown, hostname: string): string {
  const code = findNetworkCode(cause);
  const kind = code === undefined ? undefined : networkCodeKind(code);
  if (kind === undefined) {
    return `Request to ${hostname} failed`;
  }
  switch (kind) {
    case "dns": {
      return `Could not resolve host ${hostname}`;
    }
    case "refused": {
      return `Connection refused by ${hostname}`;
    }
    case "reset": {
      return `Connection reset by ${hostname}`;
    }
    case "timeout": {
      return `Connection to ${hostname} timed out`;
    }
    case "tls": {
      return `TLS certificate error for ${hostname} (${code ?? ""})`;
    }
    default: {
      return absurd(kind);
    }
  }
}

function networkCodeKind(
  code: string,
): "dns" | "refused" | "reset" | "timeout" | "tls" | undefined {
  const kind = NETWORK_CODE_KINDS.get(code);
  if (kind !== undefined) {
    return kind;
  }
  return code.startsWith("CERT_") || code.startsWith("ERR_TLS_") ? "tls" : undefined;
}

// The first recognised `code` along the cause chain; unrecognised codes keep the walk going.
function findNetworkCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    if ("code" in current && typeof current.code === "string" && networkCodeKind(current.code)) {
      return current.code;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

/** Parse a Content-Type header into mime, charset, and coarse body kind. */
export function parseContentType(contentTypeHeader: string | null | undefined): ParsedContentType {
  const contentType = contentTypeHeader?.trim() ?? "";
  const [mimePart = ""] = contentType.split(";");
  const mime = mimePart.trim().toLowerCase();
  const charsetMatch = /charset\s*=\s*['"]?(?<charset>[^;'"]+)/iu.exec(contentType);
  const charset = charsetMatch?.groups?.charset?.trim().toLowerCase();
  return { contentType, mime, charset, kind: classifyMimeType(mime) };
}

/** Classify a mime type into the coarse body kinds webfetch handles; unknown and empty types are binary. */
export function classifyMimeType(mime: string): ContentKind {
  const normalized = mime.trim().toLowerCase();
  const exactKind = MIME_KINDS.get(normalized);
  if (exactKind !== undefined) {
    return exactKind;
  }
  if (
    normalized.startsWith("text/") ||
    normalized.endsWith("+xml") ||
    normalized.endsWith("+json")
  ) {
    return "text";
  }
  return "binary";
}

/** Decode a body buffer using the declared charset, falling back to UTF-8. */
export function decodeTextBuffer(
  buffer: Readonly<Buffer>,
  charset?: string,
): { text: string; decoder: string } {
  const normalizedCharset = normalizeCharset(charset);
  if (normalizedCharset !== undefined) {
    try {
      return {
        text: new TextDecoder(normalizedCharset).decode(buffer),
        decoder: normalizedCharset,
      };
    } catch {
      // Unknown charset label: fall back to UTF-8 below.
    }
  }
  return {
    text: new TextDecoder(UTF8_LABEL).decode(buffer),
    decoder: UTF8_LABEL,
  };
}

function normalizeCharset(charset: string | undefined): string | undefined {
  if (charset === undefined) {
    return undefined;
  }
  const normalized = charset.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "utf8") {
    return UTF8_LABEL;
  }
  return normalized;
}

/** A response body streamed past its byte cap. */
export class ResponseBodyTooLarge extends Schema.TaggedError<ResponseBodyTooLarge>()(
  "ResponseBodyTooLarge",
  {},
) {}

/** A response body stream failed mid-read. */
export class ResponseBodyReadFailed extends Schema.TaggedError<ResponseBodyReadFailed>()(
  "ResponseBodyReadFailed",
  {
    /** The stream error; classify it with describeNetworkFailure. */
    cause: Schema.Defect(),
  },
) {}

/**
 * Read a response body with a hard byte cap. The reader is cancelled and released however the read
 * ends: success, cap exceeded, stream failure, or interruption.
 */
export function readResponseBodyWithLimit(
  response: Response,
  maxBytes: number,
): Effect.Effect<Buffer, ResponseBodyTooLarge | ResponseBodyReadFailed> {
  const { body } = response;
  if (body === null) {
    return Effect.succeed(Buffer.alloc(0));
  }
  return Effect.acquireUseRelease(
    Effect.sync(() => body.getReader()),
    (reader) =>
      Effect.gen(function* () {
        const chunks: Buffer[] = [];
        let bytes = 0;
        while (true) {
          const chunk = yield* Effect.tryPromise({
            try: async () => reader.read(),
            catch: (cause) => new ResponseBodyReadFailed({ cause }),
          });
          if (chunk.done) {
            return Buffer.concat(chunks);
          }
          bytes += chunk.value.byteLength;
          if (bytes > maxBytes) {
            return yield* new ResponseBodyTooLarge();
          }
          chunks.push(
            Buffer.from(chunk.value.buffer, chunk.value.byteOffset, chunk.value.byteLength),
          );
        }
      }),
    (reader) =>
      Effect.promise(async () => {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }),
  );
}

// Non-public ranges blocked for outbound fetches. IPv4-mapped IPv6 (::ffff:a.b.c.d) needs no row,
// since BlockList checks mapped addresses against the IPv4 rows. The IPv4-compatible row is ::/96,
// not ::/8: ::/8 contains ::ffff:0:0/96 and would block every mapped address, public ones too.
const NON_PUBLIC_RANGES: readonly (readonly [
  network: string,
  prefixLength: number,
  family: "ipv4" | "ipv6",
])[] = [
  ["0.0.0.0", 8, "ipv4"], // "This network"
  ["10.0.0.0", 8, "ipv4"], // Private
  ["100.64.0.0", 10, "ipv4"], // Carrier-grade NAT shared space
  ["127.0.0.0", 8, "ipv4"], // Loopback
  ["169.254.0.0", 16, "ipv4"], // Link-local, including cloud metadata endpoints
  ["172.16.0.0", 12, "ipv4"], // Private
  ["192.168.0.0", 16, "ipv4"], // Private
  ["224.0.0.0", 4, "ipv4"], // Multicast
  ["240.0.0.0", 4, "ipv4"], // Reserved, including broadcast 255.255.255.255
  ["::", 96, "ipv6"], // Unspecified, loopback, and deprecated IPv4-compatible (::a.b.c.d)
  ["64:ff9b::", 96, "ipv6"], // NAT64, which can wrap a private IPv4 address
  ["fc00::", 7, "ipv6"], // Unique local
  ["fe80::", 10, "ipv6"], // Link-local
  ["ff00::", 8, "ipv6"], // Multicast
];

const NON_PUBLIC_ADDRESSES = new BlockList();
for (const [network, prefixLength, family] of NON_PUBLIC_RANGES) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefixLength, family);
}

/** Returns true when an IP literal (v4 or v6, optionally bracketed) is in a non-public range. */
export function isPrivateOrLocalIp(input: string): boolean {
  const ip = stripIpv6Brackets(input);
  const version = isIP(ip);
  return version !== 0 && NON_PUBLIC_ADDRESSES.check(ip, version === 4 ? "ipv4" : "ipv6");
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.replace(/^\[/u, "").replace(/\]$/u, "");
}

/** A response that ended a redirect chain, with the URL it came from. */
type FetchedResponse = {
  readonly response: Response;
  readonly finalUrl: PublicHttpUrl;
};

/** Outbound port wrapping the platform fetch, so tests can record and script requests. */
export class HttpFetch extends Context.Service<
  HttpFetch,
  {
    /**
     * Send one HTTP request. Rejections are unclassified; every caller wraps the call and
     * translates them into its own typed error.
     */
    readonly fetch: (input: string | URL, init: RequestInit) => Promise<Response>;
  }
>()("pi-web-tools/network/HttpFetch") {
  /** The live layer, delegating to globalThis.fetch at call time. */
  static readonly layer = Layer.succeed(
    HttpFetch,
    HttpFetch.of({ fetch: async (input, init) => globalThis.fetch(input, init) }),
  );
}

/** Outbound port resolving host names, used by the private-host checks. */
export class DnsLookup extends Context.Service<
  DnsLookup,
  {
    /**
     * Resolve every address of a host. A rejection means the host did not resolve; the public web
     * client then lets the fetch itself report the connectivity error.
     */
    readonly lookup: (hostname: string) => Promise<readonly { readonly address: string }[]>;
  }
>()("pi-web-tools/network/DnsLookup") {
  /** The live layer over the system resolver, in resolver order. */
  static readonly layer = Layer.succeed(
    DnsLookup,
    DnsLookup.of({
      lookup: async (hostname) => {
        const records = await dnsLookup(hostname, { all: true, order: "verbatim" });
        return records.map((record) => ({ address: record.address }));
      },
    }),
  );
}

/**
 * Outbound port for fetching public web resources, with SSRF defenses, redirect re-validation, and
 * a challenge-aware user-agent retry. Interrupting a request aborts it; deadlines belong to the
 * caller.
 */
export class PublicWebClient extends Context.Service<
  PublicWebClient,
  {
    /** Fetch a bounded public web response, following safe redirects. */
    readonly get: (request: PublicWebRequest) => Effect.Effect<PublicWebResponse, PublicWebError>;
  }
>()("pi-web-tools/network/PublicWebClient") {
  /** The live client over HttpFetch and DnsLookup. */
  static readonly layer = Layer.effect(
    PublicWebClient,
    Effect.gen(function* () {
      const http = yield* HttpFetch;
      const dns = yield* DnsLookup;

      const checkPublicUrl = (
        url: URL,
      ): Effect.Effect<void, PrivateHostBlocked | PrivateIpBlocked> => {
        const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
        if (hostname === "localhost" || hostname.endsWith(".localhost")) {
          return Effect.fail(new PrivateHostBlocked());
        }
        if (isPrivateOrLocalIp(hostname)) {
          return Effect.fail(new PrivateIpBlocked());
        }
        return Effect.tryPromise({
          try: async () => dns.lookup(hostname),
          catch: () => "unresolved",
        }).pipe(
          // DNS resolution failed: let the fetch itself surface the connectivity error.
          Effect.orElseSucceed(() => []),
          Effect.flatMap((records) =>
            records.some((record) => isPrivateOrLocalIp(record.address))
              ? Effect.fail(new PrivateIpBlocked())
              : Effect.void,
          ),
        );
      };

      // One request in a redirect chain. The checks run in this order on every hop, so a redirect
      // target is held to the same rules as the requested URL.
      const fetchHop = Effect.fnUntraced(function* (
        url: URL,
        request: PublicWebRequest,
        userAgent: string,
      ): Effect.fn.Return<Response, PublicWebError> {
        if (url.username || url.password) {
          return yield* new UrlCredentialsUnsupported();
        }
        if (request.blockPrivateHosts) {
          yield* checkPublicUrl(url);
        }
        return yield* Effect.tryPromise({
          try: async (signal) =>
            http.fetch(url, {
              method: "GET",
              headers: {
                "User-Agent": userAgent,
                Accept: request.accept,
                "Accept-Language": "en-US,en;q=0.9",
              },
              signal,
              redirect: "manual",
            }),
          catch: (cause) => new PublicWebRequestFailed({ hostname: url.hostname, cause }),
        });
      });

      const fetchWithUserAgent = Effect.fnUntraced(function* (
        request: PublicWebRequest,
        userAgent: string,
      ): Effect.fn.Return<FetchedResponse, PublicWebError> {
        let currentUrl = new URL(request.url);
        for (let redirects = 0; ; redirects += 1) {
          const response = yield* fetchHop(currentUrl, request, userAgent);
          if (!REDIRECT_STATUSES.has(response.status)) {
            // fetchHop rejects credentials and resolveRedirect admits only http(s) targets, so the
            // final URL is always public; the check keeps the brand honest.
            const finalUrl = currentUrl.toString();
            if (isPublicHttpUrl(finalUrl)) {
              return { response, finalUrl };
            }
            return yield* new RedirectLocationInvalid();
          }

          yield* cancelBody(response);
          currentUrl = yield* resolveRedirect(response, {
            currentUrl,
            redirects,
            maxRedirects: request.maxRedirects,
          });
        }
      });

      // A Cloudflare challenge gets one retry with the fallback user agent; the retry's outcome,
      // challenge or not, is final.
      const fetchPastChallenge = Effect.fnUntraced(function* (
        request: PublicWebRequest,
      ): Effect.fn.Return<FetchedResponse, PublicWebError> {
        const fetched = yield* fetchWithUserAgent(request, request.userAgent);
        if (!isCloudflareChallenge(fetched.response)) {
          return fetched;
        }
        yield* cancelBody(fetched.response);
        return yield* fetchWithUserAgent(request, request.fallbackUserAgent);
      });

      const get = Effect.fn("PublicWebClient.get")(function* (
        request: PublicWebRequest,
      ): Effect.fn.Return<PublicWebResponse, PublicWebError> {
        const { response, finalUrl } = yield* fetchPastChallenge(request);
        const rejection = checkResponseHead(response, request.maxResponseBytes);
        if (rejection !== undefined) {
          yield* cancelBody(response);
          return yield* Effect.fail(rejection);
        }

        const { hostname } = new URL(finalUrl);
        const body = yield* readResponseBodyWithLimit(response, request.maxResponseBytes).pipe(
          Effect.catchTags({
            ResponseBodyTooLarge: () =>
              Effect.fail(new ResponseTooLarge({ maxBytes: request.maxResponseBytes })),
            ResponseBodyReadFailed: (error) =>
              Effect.fail(new PublicWebRequestFailed({ hostname, cause: error.cause })),
          }),
        );
        return {
          requestedUrl: request.url,
          finalUrl,
          status: response.status,
          headers: response.headers,
          body,
        };
      });

      return PublicWebClient.of({ get });
    }),
  );
}

// The redirect checks after the body is cancelled: Location present, limit, parseable, http(s).
function resolveRedirect(
  response: Response,
  hop: { readonly currentUrl: URL; readonly redirects: number; readonly maxRedirects: number },
): Effect.Effect<URL, PublicWebError> {
  const { currentUrl, redirects, maxRedirects } = hop;
  const location = response.headers.get("location");
  if (location === null || location === "") {
    return Effect.fail(new RedirectLocationMissing());
  }
  if (redirects >= maxRedirects) {
    return Effect.fail(new RedirectLimitExceeded({ maxRedirects }));
  }
  const nextUrl = parseUrl(location, currentUrl);
  if (nextUrl === undefined) {
    return Effect.fail(new RedirectLocationInvalid());
  }
  if (!HTTP_PROTOCOLS.has(nextUrl.protocol)) {
    return Effect.fail(new RedirectProtocolUnsupported({ protocol: nextUrl.protocol }));
  }
  return Effect.succeed(nextUrl);
}

function parseUrl(input: string, base: URL): URL | undefined {
  try {
    return new URL(input, base);
  } catch {
    return undefined;
  }
}

// Rejections decided from the status and headers alone, before any of the body is read.
function checkResponseHead(
  response: Response,
  maxBytes: number,
): HttpStatusRejected | ResponseTooLarge | undefined {
  if (!response.ok) {
    return new HttpStatusRejected({ status: response.status, statusText: response.statusText });
  }
  // A missing or non-numeric Content-Length parses to NaN and leaves the cap to the body read.
  const declaredBytes = parseContentLength(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    return new ResponseTooLarge({ maxBytes });
  }
  return undefined;
}

// The header's leading decimal digits, as parseInt reads them, so a repeated header ("5, 5") still
// counts; a header without leading digits reads as NaN.
function parseContentLength(header: string | null): number {
  const digits = LEADING_DIGITS_RE.exec(header ?? "")?.[0];
  return digits === undefined ? Number.NaN : Number(digits);
}

function cancelBody(response: Response): Effect.Effect<void> {
  return Effect.promise(async () => {
    await response.body?.cancel().catch(() => undefined);
  });
}

function isCloudflareChallenge(response: Pick<Response, "status" | "headers">): boolean {
  return response.status === 403 && response.headers.get("cf-mitigated") === "challenge";
}
