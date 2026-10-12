import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { Effect, Result } from "effect";
import { assert, describe, expect, test } from "vitest";
import {
  readResponseBodyWithLimit,
  ResponseBodyReadFailed,
  ResponseBodyTooLarge,
} from "../network";
import { PublicWebTransport } from "../public-web-transport";

function transportService(): PublicWebTransport["Service"] {
  return Effect.runSync(
    Effect.gen(function* () {
      return yield* PublicWebTransport;
    }).pipe(Effect.provide(PublicWebTransport.layer)),
  );
}

function uninitializedDeferred(): never {
  throw new Error("Deferred promise was not initialized");
}

function undefinedDeferred(): {
  readonly promise: Promise<undefined>;
  readonly resolve: () => void;
} {
  let resolvePromise: () => void = uninitializedDeferred;
  const promise = new Promise<undefined>((resolve) => {
    resolvePromise = () => {
      resolve(undefined);
    };
  });
  return { promise, resolve: resolvePromise };
}

async function settleWithin<A>(promise: Promise<A>, milliseconds: number): Promise<A> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Timed out waiting for the local connection to close"));
    }, milliseconds);
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function withLocalServer<A>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (port: number) => Promise<A>,
): Promise<A> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert(typeof address === "object" && address !== null);
    return await run(address.port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

describe("PublicWebTransport", () => {
  test("connects through the supplied address while retaining the original Host name", async () => {
    const seenHosts: string[] = [];
    await withLocalServer(
      (request, response) => {
        seenHosts.push(String(request.headers.host));
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("address-bound");
      },
      async (port) => {
        const url = new URL(`http://does-not-resolve.invalid:${port}/page`);
        const response = await transportService().get(url, [{ address: "127.0.0.1", family: 4 }], {
          headers: { Accept: "text/plain" },
          signal: new AbortController().signal,
        });
        await expect(response.text()).resolves.toBe("address-bound");
        expect(seenHosts).toStrictEqual([`does-not-resolve.invalid:${port}`]);
      },
    );
  });

  test("rejects empty and mismatched address lists for an IP literal without a request", async () => {
    let requests = 0;
    await withLocalServer(
      (_request, response) => {
        requests += 1;
        response.end("must not be reached");
      },
      async (port) => {
        const url = new URL(`http://127.0.0.1:${port}/`);
        await expect(
          transportService().get(url, [{ address: "127.0.0.2", family: 4 }], {
            headers: { Accept: "text/plain" },
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow("IP literal is not an approved address");
        await expect(
          transportService().get(url, [], {
            headers: { Accept: "text/plain" },
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow("No approved address is available");
        expect(requests).toBe(0);
      },
    );
  });

  test("terminates a body-forbidden response instead of draining it in the background", async () => {
    const connectionClosed = undefinedDeferred();
    await withLocalServer(
      (request, response) => {
        request.socket.once("close", connectionClosed.resolve);
        response.writeHead(205, { "transfer-encoding": "chunked" });
        response.write("an invalid body that never ends");
      },
      async (port) => {
        const response = await transportService().get(
          new URL(`http://body-forbidden.invalid:${port}/`),
          [{ address: "127.0.0.1", family: 4 }],
          {
            headers: { Accept: "text/plain" },
            signal: new AbortController().signal,
          },
        );
        expect(response.status).toBe(205);
        expect(response.body).toBeNull();
        await expect(settleWithin(connectionClosed.promise, 1000)).resolves.toBeUndefined();
      },
    );
  });

  test("caps decompressed bytes and closes a compressed response that never ends", async () => {
    const connectionClosed = undefinedDeferred();
    await withLocalServer(
      (request, response) => {
        request.socket.once("close", connectionClosed.resolve);
        const compressed = gzipSync("expanded response".repeat(100));
        response.writeHead(200, { "content-encoding": "gzip" });
        response.write(compressed.subarray(0, compressed.byteLength - 8));
      },
      async (port) => {
        const response = await transportService().get(
          new URL(`http://compressed.invalid:${port}/`),
          [{ address: "127.0.0.1", family: 4 }],
          {
            headers: { "Accept-Encoding": "gzip" },
            signal: new AbortController().signal,
          },
        );
        expect(response.headers.get("content-encoding")).toBeNull();
        expect(response.headers.get("content-length")).toBeNull();
        const body = await Effect.runPromise(Effect.result(readResponseBodyWithLimit(response, 8)));
        expect(body).toStrictEqual(Result.fail(new ResponseBodyTooLarge()));
        await expect(settleWithin(connectionClosed.promise, 1000)).resolves.toBeUndefined();
      },
    );
  });

  test("decodes stacked content encodings in reverse order", async () => {
    const text = "stacked compression".repeat(100);
    await withLocalServer(
      (_request, response) => {
        response.writeHead(200, { "content-encoding": "gzip, br" });
        response.end(brotliCompressSync(gzipSync(text)));
      },
      async (port) => {
        const response = await transportService().get(
          new URL(`http://stacked-compression.invalid:${port}/`),
          [{ address: "127.0.0.1", family: 4 }],
          {
            headers: { "Accept-Encoding": "gzip, br" },
            signal: new AbortController().signal,
          },
        );

        expect(response.headers.get("content-encoding")).toBeNull();
        await expect(response.text()).resolves.toBe(text);
      },
    );
  });

  test("leaves unknown content encodings untouched", async () => {
    await withLocalServer(
      (_request, response) => {
        response.writeHead(200, { "content-encoding": "future-coding" });
        response.end("opaque bytes");
      },
      async (port) => {
        const response = await transportService().get(
          new URL(`http://unknown-compression.invalid:${port}/`),
          [{ address: "127.0.0.1", family: 4 }],
          {
            headers: { "Accept-Encoding": "future-coding" },
            signal: new AbortController().signal,
          },
        );

        expect(response.headers.get("content-encoding")).toBe("future-coding");
        await expect(response.text()).resolves.toBe("opaque bytes");
      },
    );
  });

  test.each(["future-coding, gzip", "gzip, future-coding", "gzip, identity, future-coding, br"])(
    "leaves the entire unsupported stack %s and its length untouched",
    async (encoding) => {
      const opaque = gzipSync("opaque stacked bytes");
      await withLocalServer(
        (_request, response) => {
          response.writeHead(200, {
            "content-encoding": encoding,
            "content-length": opaque.byteLength,
          });
          response.end(opaque);
        },
        async (port) => {
          const response = await transportService().get(
            new URL(`http://unknown-stack.invalid:${port}/`),
            [{ address: "127.0.0.1", family: 4 }],
            { headers: {}, signal: new AbortController().signal },
          );
          expect(response.headers.get("content-encoding")).toBe(encoding);
          expect(response.headers.get("content-length")).toBe(String(opaque.byteLength));
          expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(
            new Uint8Array(opaque),
          );
        },
      );
    },
  );

  test("propagates an interrupted Node response body as a read failure", async () => {
    await withLocalServer(
      (_request, response) => {
        response.writeHead(200, { "content-length": "1000" });
        response.write("partial bytes");
        setImmediate(() => response.destroy());
      },
      async (port) => {
        const response = await transportService().get(
          new URL(`http://interrupted.invalid:${port}/`),
          [{ address: "127.0.0.1", family: 4 }],
          { headers: {}, signal: new AbortController().signal },
        );
        await expect(response.text()).rejects.toThrow("aborted");
      },
    );
  });

  test("body cancellation closes an uncompressed Node response that never ends", async () => {
    const connectionClosed = undefinedDeferred();
    await withLocalServer(
      (request, response) => {
        request.socket.once("close", connectionClosed.resolve);
        response.writeHead(200);
        response.write("ongoing bytes");
      },
      async (port) => {
        const response = await transportService().get(
          new URL(`http://cancel-body.invalid:${port}/`),
          [{ address: "127.0.0.1", family: 4 }],
          { headers: {}, signal: new AbortController().signal },
        );
        assert(response.body !== null);
        const reader = response.body.getReader();
        const first = await reader.read();
        expect(first.done).toBe(false);
        expect(first.value).toBeInstanceOf(Uint8Array);
        await reader.cancel();
        reader.releaseLock();
        await expect(settleWithin(connectionClosed.promise, 1000)).resolves.toBeUndefined();
      },
    );
  });

  test("cancelling a pending body read releases its reader and socket", async () => {
    const connectionClosed = undefinedDeferred();
    await withLocalServer(
      (request, response) => {
        request.socket.once("close", connectionClosed.resolve);
        response.writeHead(200);
        response.flushHeaders();
      },
      async (port) => {
        const response = await transportService().get(
          new URL(`http://pending-read.invalid:${port}/`),
          [{ address: "127.0.0.1", family: 4 }],
          { headers: {}, signal: new AbortController().signal },
        );
        assert(response.body !== null);
        const reader = response.body.getReader();
        const pendingRead = reader.read();
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });

        await reader.cancel();
        await expect(pendingRead).resolves.toMatchObject({ done: true });
        reader.releaseLock();
        expect(response.body.locked).toBe(false);
        await expect(settleWithin(connectionClosed.promise, 1000)).resolves.toBeUndefined();
      },
    );
  });

  test("surfaces malformed compressed response errors", async () => {
    await withLocalServer(
      (_request, response) => {
        response.writeHead(200, { "content-encoding": "gzip" });
        response.end("not gzip data");
      },
      async (port) => {
        const response = await transportService().get(
          new URL(`http://bad-compression.invalid:${port}/`),
          [{ address: "127.0.0.1", family: 4 }],
          {
            headers: { "Accept-Encoding": "gzip" },
            signal: new AbortController().signal,
          },
        );
        const body = await Effect.runPromise(
          Effect.result(readResponseBodyWithLimit(response, 1024)),
        );
        expect(body).toStrictEqual(
          Result.fail(new ResponseBodyReadFailed({ cause: expect.any(Error) })),
        );
      },
    );
  });
});
