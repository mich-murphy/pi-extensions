import { request as requestHttp } from "node:http";
import type { IncomingMessage } from "node:http";
import { request as requestHttps } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { pipeline, Readable } from "node:stream";
import type { Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Context, Layer } from "effect";

/** One address approved for a public-web connection. */
export type ApprovedAddress = {
  /** Numeric IPv4 or IPv6 address. */
  readonly address: string;
  /** Address family of {@link address}. */
  readonly family: 4 | 6;
};

type AddressBoundRequest = {
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
};

/**
 * HTTP transport for public-web requests. Unlike the platform Fetch API, this port accepts the
 * exact addresses already approved by the caller and cannot perform an independent DNS lookup.
 */
export class PublicWebTransport extends Context.Service<
  PublicWebTransport,
  {
    /** Send one GET while connecting only to an approved address. */
    readonly get: (
      url: URL,
      addresses: readonly ApprovedAddress[],
      request: {
        /** Request headers. Host is deliberately left to Node so it comes from the original URL. */
        readonly headers: Readonly<Record<string, string>>;
        /** Cancellation signal owned by the calling effect. */
        readonly signal: AbortSignal;
      },
    ) => Promise<Response>;
  }
>()("pi-web-tools/public-web-transport/PublicWebTransport") {
  /**
   * Live Node HTTP(S) transport. The request URL retains the original hostname, so Node emits the
   * original Host header and uses that hostname for TLS SNI and certificate verification; only
   * socket address selection is replaced by the approved-address lookup.
   */
  static readonly layer = Layer.succeed(
    PublicWebTransport,
    PublicWebTransport.of({
      get: async (url, addresses, request) => sendAddressBoundRequest(url, addresses, request),
    }),
  );
}

async function sendAddressBoundRequest(
  url: URL,
  addresses: readonly ApprovedAddress[],
  request: AddressBoundRequest,
): Promise<Response> {
  assertConnectionTarget(url, addresses);
  return new Promise<Response>((resolve, reject) => {
    const send = url.protocol === "https:" ? requestHttps : requestHttp;
    const outgoing = send(
      url,
      {
        method: "GET",
        headers: request.headers,
        signal: request.signal,
        lookup: approvedAddressLookup(addresses),
        // A request owns its socket. Cancelling or consuming its Response therefore releases every
        // resource without retaining an address-bound socket in a process-wide pool.
        agent: false,
      },
      (incoming) => {
        try {
          resolve(toFetchResponse(incoming));
        } catch (cause) {
          incoming.destroy();
          reject(cause instanceof Error ? cause : new Error("Could not create HTTP response"));
        }
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

function assertConnectionTarget(url: URL, addresses: readonly ApprovedAddress[]): void {
  if (addresses.length === 0) {
    throw Object.assign(new Error("No approved address is available"), { code: "ENOTFOUND" });
  }
  const hostname = url.hostname.replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase();
  const family = isIP(hostname);
  if (
    (family === 4 || family === 6) &&
    !addresses.some(
      (candidate) =>
        candidate.family === family &&
        candidate.address.replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase() === hostname,
    )
  ) {
    throw Object.assign(new Error("IP literal is not an approved address"), { code: "ENOTFOUND" });
  }
}

function approvedAddressLookup(addresses: readonly ApprovedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const requestedFamily = options.family === 4 || options.family === 6 ? options.family : 0;
    const eligible = addresses.filter(
      (candidate) => requestedFamily === 0 || candidate.family === requestedFamily,
    );
    queueMicrotask(() => {
      if (eligible.length === 0) {
        const error = Object.assign(new Error("No approved address is available"), {
          code: "ENOTFOUND",
        });
        callback(error, "");
        return;
      }
      if (options.all === true) {
        callback(
          null,
          eligible.map(({ address, family }) => ({ address, family })),
        );
        return;
      }
      const first = eligible[0];
      if (first === undefined) {
        callback(
          Object.assign(new Error("No approved address is available"), { code: "ENOTFOUND" }),
          "",
        );
        return;
      }
      callback(null, first.address, first.family);
    });
  };
}

function toFetchResponse(incoming: IncomingMessage): Response {
  const headers = responseHeaders(incoming);
  const status = incoming.statusCode ?? 500;
  const bodyForbidden = status === 204 || status === 205 || status === 304;
  if (bodyForbidden) {
    // There is no Response body for the caller to cancel. Destroy the owned stream/socket rather
    // than draining a malformed chunked 204/205/304 response forever in the background.
    incoming.destroy();
    return new Response(null, { status, statusText: incoming.statusMessage ?? "", headers });
  }

  const decoded = decodedResponseBody(incoming, headers.get("content-encoding"));
  if (decoded) {
    // Content-Length describes compressed bytes, not the bytes checked by PublicWebClient.
    headers.delete("content-encoding");
    headers.delete("content-length");
  }
  return new Response(webReadable(decoded ?? incoming), {
    status,
    statusText: incoming.statusMessage ?? "",
    headers,
  });
}

function responseHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    const name = incoming.rawHeaders[index];
    const value = incoming.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) {
      headers.append(name, value);
    }
  }
  return headers;
}

function decoderFor(encoding: string): Transform | "identity" | undefined {
  if (encoding === "gzip" || encoding === "x-gzip") {
    return createGunzip();
  }
  if (encoding === "deflate") {
    return createInflate();
  }
  if (encoding === "br") {
    return createBrotliDecompress();
  }
  return encoding === "identity" ? "identity" : undefined;
}

function decodedResponseBody(
  incoming: IncomingMessage,
  contentEncoding: string | null,
): Readable | undefined {
  const encodings =
    contentEncoding
      ?.split(",")
      .map((encoding) => encoding.trim().toLowerCase())
      .filter(Boolean) ?? [];
  const selected = encodings.map((encoding) => decoderFor(encoding));
  // Preserve an unknown encoding and its header verbatim instead of partially decoding a stack.
  if (selected.length === 0 || selected.some((decoder) => decoder === undefined)) {
    return undefined;
  }
  const decoders = selected
    .toReversed()
    .filter((decoder): decoder is Transform => decoder !== "identity");
  const output = decoders.at(-1);
  if (output === undefined) {
    return undefined;
  }
  // Content codings are applied in header order and decoded in reverse. A single pipeline carries
  // cancellation and decode failures through every transform and back to the owned socket.
  pipeline([incoming, ...decoders], () => undefined);
  return output;
}

const WEB_STREAM_HIGH_WATER_MARK_BYTES = 64 * 1024;

// IncomingMessage and every zlib decoder used here are binary, non-object-mode streams, so Node's
// toWeb adapter always supplies Uint8Array chunks to this strategy callback.
const chunkByteLength = (chunk: Uint8Array): number => chunk.byteLength;

function webReadable(stream: Readable): ReadableStream<Uint8Array> {
  const converted = Readable.toWeb(stream, {
    strategy: {
      highWaterMark: WEB_STREAM_HIGH_WATER_MARK_BYTES,
      size: chunkByteLength,
    },
  });
  // SAFETY: The binary stream invariant above also makes Node's stream/web value compatible with
  // Fetch's global ReadableStream; their declarations differ only in ArrayBuffer generic details.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- justified by the binary stream invariant above.
  return converted as unknown as ReadableStream<Uint8Array>;
}
