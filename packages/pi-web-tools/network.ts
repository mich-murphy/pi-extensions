import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { err, ok } from "./result";
import type { Result } from "./result";
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

/** Expected failures of the public web client. Messages derived from these never contain URLs or causes. */
export type PublicWebError =
  | { readonly _tag: "PublicWebRequestFailed" }
  | { readonly _tag: "PublicWebCancelled" }
  | { readonly _tag: "PublicWebTimedOut"; readonly timeoutSeconds: number }
  | { readonly _tag: "PrivateHostBlocked" }
  | { readonly _tag: "PrivateIpBlocked" }
  | { readonly _tag: "UrlCredentialsUnsupported" }
  | { readonly _tag: "RedirectLocationMissing" }
  | { readonly _tag: "RedirectLocationInvalid" }
  | { readonly _tag: "RedirectLimitExceeded"; readonly maxRedirects: number }
  | { readonly _tag: "RedirectProtocolUnsupported"; readonly protocol: string }
  | { readonly _tag: "HttpStatusRejected"; readonly status: number; readonly statusText: string }
  | { readonly _tag: "ResponseTooLarge"; readonly maxBytes: number };

/** Outbound port for fetching public web resources. */
export type PublicWebClient = {
  readonly get: (
    request: PublicWebRequest,
    options?: { readonly signal?: AbortSignal | undefined },
  ) => Promise<Result<PublicWebResponse, PublicWebError>>;
};

/** DNS resolver seam, injectable for tests. */
export type DnsLookup = (hostname: string) => Promise<readonly { address: string }[]>;

/** The shape of an operation-deadline abort reason. */
type OperationTimeout = { readonly _tag: "OperationTimeout"; readonly timeoutSeconds: number };

/** Error aborting an operation after its deadline. */
class OperationTimeoutError extends Error implements OperationTimeout {
  readonly _tag = "OperationTimeout" as const;

  constructor(readonly timeoutSeconds: number) {
    super(`Operation timed out after ${timeoutSeconds}s`);
    this.name = "OperationTimeoutError";
  }
}

/** A composed abort signal plus its cleanup callback. */
export type ComposedSignal = {
  readonly signal: AbortSignal;
  readonly cleanup: () => void;
};

/** Compose an operation deadline with an optional outer (agent) abort signal. */
export function createOperationSignal(
  timeoutMs: number,
  outerSignal?: AbortSignal,
): ComposedSignal {
  const controller = new AbortController();
  const timeoutSeconds = Math.ceil(timeoutMs / 1000);
  const timeoutId = setTimeout(() => {
    controller.abort(new OperationTimeoutError(timeoutSeconds));
  }, timeoutMs);
  const signal = outerSignal
    ? AbortSignal.any([outerSignal, controller.signal])
    : controller.signal;
  return {
    signal,
    cleanup: () => {
      clearTimeout(timeoutId);
    },
  };
}

/** Returns true when a value is an operation-deadline abort reason. */
export function isOperationTimeoutError(value: unknown): value is OperationTimeout {
  return (
    value instanceof OperationTimeoutError ||
    (typeof value === "object" &&
      value !== null &&
      "_tag" in value &&
      value._tag === "OperationTimeout" &&
      "timeoutSeconds" in value &&
      typeof value.timeoutSeconds === "number")
  );
}

/** Returns true when an error is a DOMException-style abort. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
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

/** Read a response body with a hard byte cap, returning a tagged failure instead of throwing. */
export async function readResponseBodyWithLimit(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<
  Result<Buffer, { readonly _tag: "BodyTooLarge" } | { readonly _tag: "BodyReadFailed" }>
> {
  if (!response.body) {
    return ok(Buffer.alloc(0));
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;

  try {
    while (true) {
      if (signal?.aborted === true) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- cancelling ends the read loop
        await reader.cancel(signal.reason).catch(() => undefined);
        return err({ _tag: "BodyReadFailed" });
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- a stream yields its chunks one read at a time
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      bytes += value.byteLength;
      if (bytes > maxBytes) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- cancelling ends the read loop
        await reader.cancel().catch(() => undefined);
        return err({ _tag: "BodyTooLarge" });
      }

      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } catch {
    return err({ _tag: "BodyReadFailed" });
  } finally {
    reader.releaseLock();
  }

  return ok(Buffer.concat(chunks));
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

/** What stays fixed across the hops of one redirect chain. */
type FetchAttempt = {
  readonly fetchImpl: typeof fetch;
  readonly request: PublicWebRequest;
  readonly userAgent: string;
  readonly signal: AbortSignal | undefined;
};

/** Public web client with SSRF defenses, redirect re-validation, and a challenge-aware UA retry. */
export class FetchPublicWebClient implements PublicWebClient {
  constructor(
    private readonly dependencies: {
      readonly fetchImpl?: typeof fetch;
      readonly lookup?: DnsLookup;
    } = {},
  ) {}

  /** Fetch a bounded public web response, following safe redirects. */
  async get(
    request: PublicWebRequest,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<Result<PublicWebResponse, PublicWebError>> {
    const fetched = await this.fetchPastChallenge(request, options.signal);
    if (fetched._tag === "err") {
      return fetched;
    }

    const { response, finalUrl } = fetched.value;
    const head = checkResponseHead(response, request.maxResponseBytes);
    if (head._tag === "err") {
      await cancelBody(response);
      return head;
    }

    const body = await readResponseBodyWithLimit(
      response,
      request.maxResponseBytes,
      options.signal,
    );
    if (body._tag === "err") {
      return err(classifyBodyReadFailure(body.error, request.maxResponseBytes, options.signal));
    }

    return ok({
      requestedUrl: request.url,
      finalUrl,
      status: response.status,
      headers: response.headers,
      body: body.value,
    });
  }

  // A Cloudflare challenge gets one retry with the fallback user agent; the retry's outcome,
  // challenge or not, is final.
  private async fetchPastChallenge(
    request: PublicWebRequest,
    signal: AbortSignal | undefined,
  ): Promise<Result<FetchedResponse, PublicWebError>> {
    const first = await this.fetchWithUserAgent(request, request.userAgent, signal);
    if (first._tag === "err" || !isCloudflareChallenge(first.value.response)) {
      return first;
    }
    await cancelBody(first.value.response);
    return this.fetchWithUserAgent(request, request.fallbackUserAgent, signal);
  }

  private async fetchWithUserAgent(
    request: PublicWebRequest,
    userAgent: string,
    signal: AbortSignal | undefined,
  ): Promise<Result<FetchedResponse, PublicWebError>> {
    const fetchImpl = this.dependencies.fetchImpl ?? fetch;
    const attempt: FetchAttempt = { fetchImpl, request, userAgent, signal };
    let currentUrl = new URL(request.url);

    for (let redirects = 0; ; redirects += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each hop requests the previous hop's redirect target
      const hop = await this.fetchHop(currentUrl, attempt);
      if (hop._tag === "err") {
        return hop;
      }

      const response = hop.value;
      if (!REDIRECT_STATUSES.has(response.status)) {
        // fetchHop rejects credentials and resolveRedirect admits only http(s) targets, so the
        // final URL is always public; the check keeps the brand honest.
        const finalUrl = currentUrl.toString();
        return isPublicHttpUrl(finalUrl)
          ? ok({ response, finalUrl })
          : err({ _tag: "RedirectLocationInvalid" });
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- the body is released before the next hop
      await cancelBody(response);
      const next = resolveRedirect(response, {
        currentUrl,
        redirects,
        maxRedirects: request.maxRedirects,
      });
      if (next._tag === "err") {
        return next;
      }
      currentUrl = next.value;
    }
  }

  // One request in a redirect chain. The checks run in this order on every hop, so a redirect
  // target is held to the same rules as the requested URL.
  private async fetchHop(
    url: URL,
    attempt: FetchAttempt,
  ): Promise<Result<Response, PublicWebError>> {
    const { fetchImpl, request, userAgent, signal } = attempt;
    if (signal?.aborted === true) {
      return err(classifySignalAbort(signal));
    }
    if (url.username || url.password) {
      return err({ _tag: "UrlCredentialsUnsupported" });
    }
    if (request.blockPrivateHosts) {
      const publicCheck = await this.checkPublicUrl(url);
      if (publicCheck._tag === "err") {
        return publicCheck;
      }
    }

    try {
      return ok(
        await fetchImpl(url, {
          method: "GET",
          headers: {
            "User-Agent": userAgent,
            Accept: request.accept,
            "Accept-Language": "en-US,en;q=0.9",
          },
          signal: signal ?? null,
          redirect: "manual",
        }),
      );
    } catch (error: unknown) {
      return err(classifyFetchFailure(error, signal));
    }
  }

  private async checkPublicUrl(url: URL): Promise<Result<void, PublicWebError>> {
    const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      return err({ _tag: "PrivateHostBlocked" });
    }
    if (isPrivateOrLocalIp(hostname)) {
      return err({ _tag: "PrivateIpBlocked" });
    }

    const lookupImpl =
      this.dependencies.lookup ??
      (async (name: string) => {
        const records = await lookup(name, { all: true, order: "verbatim" });
        return records.map((record) => ({ address: record.address }));
      });

    try {
      const records = await lookupImpl(hostname);
      for (const record of records) {
        if (isPrivateOrLocalIp(record.address)) {
          return err({ _tag: "PrivateIpBlocked" });
        }
      }
    } catch {
      // DNS resolution failed: let the fetch itself surface the connectivity error.
    }

    return ok(undefined);
  }
}

function classifySignalAbort(signal: AbortSignal): PublicWebError {
  if (isOperationTimeoutError(signal.reason)) {
    return { _tag: "PublicWebTimedOut", timeoutSeconds: signal.reason.timeoutSeconds };
  }
  return { _tag: "PublicWebCancelled" };
}

// An abort surfaces as the signal's reason when there is a signal; any other rejection is a
// request failure whose cause is not carried.
function classifyFetchFailure(cause: unknown, signal: AbortSignal | undefined): PublicWebError {
  if (signal?.aborted === true || isAbortError(cause)) {
    return signal ? classifySignalAbort(signal) : { _tag: "PublicWebCancelled" };
  }
  return { _tag: "PublicWebRequestFailed" };
}

// The redirect checks after the body is cancelled: Location present, limit, parseable, http(s).
function resolveRedirect(
  response: Response,
  hop: { readonly currentUrl: URL; readonly redirects: number; readonly maxRedirects: number },
): Result<URL, PublicWebError> {
  const { currentUrl, redirects, maxRedirects } = hop;
  const location = response.headers.get("location");
  if (location === null || location === "") {
    return err({ _tag: "RedirectLocationMissing" });
  }
  if (redirects >= maxRedirects) {
    return err({ _tag: "RedirectLimitExceeded", maxRedirects });
  }
  const nextUrl = parseUrl(location, currentUrl);
  if (nextUrl === undefined) {
    return err({ _tag: "RedirectLocationInvalid" });
  }
  if (!HTTP_PROTOCOLS.has(nextUrl.protocol)) {
    return err({ _tag: "RedirectProtocolUnsupported", protocol: nextUrl.protocol });
  }
  return ok(nextUrl);
}

function parseUrl(input: string, base: URL): URL | undefined {
  try {
    return new URL(input, base);
  } catch {
    return undefined;
  }
}

// Rejections decided from the status and headers alone, before any of the body is read.
function checkResponseHead(response: Response, maxBytes: number): Result<void, PublicWebError> {
  if (!response.ok) {
    return err({
      _tag: "HttpStatusRejected",
      status: response.status,
      statusText: response.statusText,
    });
  }
  // A missing or non-numeric Content-Length parses to NaN and leaves the cap to the body read.
  const declaredBytes = parseContentLength(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    return err({ _tag: "ResponseTooLarge", maxBytes });
  }
  return ok(undefined);
}

// The header's leading decimal digits, as parseInt reads them, so a repeated header ("5, 5") still
// counts; a header without leading digits reads as NaN.
function parseContentLength(header: string | null): number {
  const digits = LEADING_DIGITS_RE.exec(header ?? "")?.[0];
  return digits === undefined ? Number.NaN : Number(digits);
}

// An aborted signal explains any body failure, so it wins over the reader's own tag.
function classifyBodyReadFailure(
  error: { readonly _tag: "BodyTooLarge" | "BodyReadFailed" },
  maxBytes: number,
  signal: AbortSignal | undefined,
): PublicWebError {
  if (signal?.aborted === true) {
    return classifySignalAbort(signal);
  }
  if (error._tag === "BodyTooLarge") {
    return { _tag: "ResponseTooLarge", maxBytes };
  }
  return { _tag: "PublicWebRequestFailed" };
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function isCloudflareChallenge(response: Pick<Response, "status" | "headers">): boolean {
  return response.status === 403 && response.headers.get("cf-mitigated") === "challenge";
}
