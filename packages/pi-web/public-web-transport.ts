import { request as requestHttp } from "node:http";
import type { IncomingMessage } from "node:http";
import { request as requestHttps } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { pipeline, Readable } from "node:stream";
import type { Transform } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Context, Layer } from "effect";

export type ApprovedAddress = {
  readonly address: string;
  readonly family: 4 | 6;
};

type AddressBoundRequest = {
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
};

export class PublicWebTransport extends Context.Service<
  PublicWebTransport,
  {
    readonly get: (
      url: URL,
      addresses: readonly ApprovedAddress[],
      request: {
        readonly headers: Readonly<Record<string, string>>;
        readonly signal: AbortSignal;
      },
    ) => Promise<Response>;
  }
>()("pi-web/public-web-transport/PublicWebTransport") {
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
    incoming.destroy();
    return new Response(null, { status, statusText: incoming.statusMessage ?? "", headers });
  }

  const decoded = decodedResponseBody(incoming, headers.get("content-encoding"));
  if (decoded) {
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

type CompressionCoding = "gzip" | "deflate" | "br";
type ContentDecodingPlan =
  | { readonly kind: "untouched" }
  | {
      readonly kind: "decode";
      readonly codings: readonly [CompressionCoding, ...CompressionCoding[]];
    };

function contentDecodingPlan(contentEncoding: string | null): ContentDecodingPlan {
  const encodings =
    contentEncoding
      ?.split(",")
      .map((encoding) => encoding.trim().toLowerCase())
      .filter(Boolean) ?? [];
  const codings: CompressionCoding[] = [];
  for (const encoding of encodings) {
    switch (encoding) {
      case "gzip":
      case "x-gzip": {
        codings.push("gzip");
        break;
      }
      case "deflate":
      case "br": {
        codings.push(encoding);
        break;
      }
      case "identity": {
        break;
      }
      default: {
        return { kind: "untouched" };
      }
    }
  }
  const [firstCoding, ...remainingCodings] = codings;
  return firstCoding === undefined
    ? { kind: "untouched" }
    : { kind: "decode", codings: [firstCoding, ...remainingCodings] };
}

function decoderFor(encoding: CompressionCoding): Transform {
  if (encoding === "gzip") {
    return createGunzip();
  }
  if (encoding === "deflate") {
    return createInflate();
  }
  return createBrotliDecompress();
}

function decodedResponseBody(
  incoming: IncomingMessage,
  contentEncoding: string | null,
): Readable | undefined {
  const plan = contentDecodingPlan(contentEncoding);
  if (plan.kind === "untouched") {
    return undefined;
  }
  const [firstAppliedCoding, ...laterAppliedCodings] = plan.codings;
  const output = decoderFor(firstAppliedCoding);
  const decoders = [
    ...laterAppliedCodings.toReversed().map((coding) => decoderFor(coding)),
    output,
  ];
  pipeline([incoming, ...decoders], () => undefined);
  return output;
}

const WEB_STREAM_HIGH_WATER_MARK_BYTES = 64 * 1024;

function parseByteChunk(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) {
    return chunk;
  }
  throw new TypeError("HTTP response stream supplied a non-byte chunk");
}

function webReadable(stream: Readable): ReadableStream<Uint8Array> {
  const converted: NodeReadableStream<unknown> = Readable.toWeb(stream, {
    strategy: {
      highWaterMark: WEB_STREAM_HIGH_WATER_MARK_BYTES,
      size: (chunk: Uint8Array) => chunk.byteLength,
    },
  });
  const reader = converted.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            reader.releaseLock();
            controller.close();
          } else {
            controller.enqueue(parseByteChunk(chunk.value));
          }
        } catch (cause) {
          try {
            await reader.cancel(cause).catch(ignoreAlreadyRejectedCancellation);
          } finally {
            reader.releaseLock();
          }
          controller.error(cause);
        }
      },
      async cancel(reason: unknown) {
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      },
    },
    { highWaterMark: 0 },
  );
}

function ignoreAlreadyRejectedCancellation(): undefined {
  return undefined;
}
