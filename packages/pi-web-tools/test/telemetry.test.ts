import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { inspect } from "node:util";
import { describe, expect, test } from "@effect/vitest";
import { Cause, Duration, Effect, Exit, Tracer } from "effect";
import { withSafeSpan } from "../telemetry";
import { ToolOutputStore } from "../tool-output";
import {
  fetchPageWith,
  mcpClientWith,
  providerHttpWith,
  publicUrl,
  publicWebClientWith,
} from "./fakes";

function recordingTracer() {
  const spans: Tracer.NativeSpan[] = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { spans, tracer };
}

function exportedSpans(spans: readonly Tracer.NativeSpan[]): string {
  return inspect(
    spans.map((span) => ({
      name: span.name,
      attributes: [...span.attributes],
      events: span.events,
      status: span.status,
      error:
        span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
          ? Cause.pretty(span.status.exit.cause)
          : undefined,
    })),
    { depth: null },
  );
}

describe("safe telemetry", () => {
  test("HTTP spans export only allowlisted network codes, not reflected keys or request arguments", async () => {
    const key = "synthetic-reflected-key";
    for (const [code, expectedCode] of [
      ["ENOTFOUND", "ENOTFOUND"],
      ["CERT_HAS_EXPIRED", "CERT_HAS_EXPIRED"],
      [`CERT_${key}`, ""],
      [undefined, ""],
    ]) {
      for (const streamFailure of [false, true]) {
        const { spans, tracer } = recordingTracer();
        const error = Object.assign(new Error(`message ${key}`), { code, payload: key });
        const client = providerHttpWith(reflectingFetch(streamFailure, key, error));
        const exit = await Effect.runPromiseExit(
          client
            .postJson({
              url: "https://api.example/search",
              headers: { "x-api-key": key },
              body: { key },
              timeout: Duration.seconds(5),
              maxResponseBytes: 1024,
            })
            .pipe(Effect.provideService(Tracer.Tracer, tracer)),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(spans.map((span) => span.name)).toContain("ProviderHttpClient.postJson");
        const exported = exportedSpans(spans);
        expect(exported).not.toContain(key);
        expect(exported).toContain(expectedCode);
      }
    }
  });

  test("MCP failure spans scrub current and rotated keys before truncation", async () => {
    const secrets = ["secret", `secret${"-suffix".repeat(60)}`, "rotated-key"];
    for (const rpc of [true, false]) {
      const { spans, tracer } = recordingTracer();
      let calls = 0;
      const client = mcpClientWith(publicUrl("https://mcp.example/mcp"), {
        timeoutMs: 5000,
        maxResponseBytes: 8192,
        fetchImpl: async () => {
          calls += 1;
          const text = `${"x".repeat(170)} ${secrets.join(" ")}`;
          return reflectedMcpResponse(calls, text, rpc);
        },
      });
      await Effect.runPromiseExit(
        client
          .callTool("search", { query: secrets[0] }, secrets)
          .pipe(Effect.provideService(Tracer.Tracer, tracer)),
      );
      const exported = exportedSpans(spans);
      expect(spans.map((span) => span.name)).toContain("McpClient.callTool");
      expect(exported).toContain("ProviderToolError");
      expect(exported).not.toContain("-suffix");
      for (const secret of secrets) {
        expect(exported).not.toContain(secret);
      }
    }
  });

  test("successful HTTP, MCP and direct page spans never retain response payloads", async () => {
    const key = "synthetic-success-reflection-key";
    const { spans, tracer } = recordingTracer();
    const http = providerHttpWith(async () => new Response(key));
    const request = {
      url: "https://api.example/search",
      headers: { "x-api-key": key },
      timeout: Duration.seconds(5),
      maxResponseBytes: 8192,
    };
    for (const operation of [http.getJson(request), http.postJson(request)]) {
      const result = await Effect.runPromise(
        operation.pipe(Effect.provideService(Tracer.Tracer, tracer)),
      );
      expect(result.bodyText).toBe(key);
    }
    const mcp = mcpClientWith(publicUrl("https://mcp.example/mcp"), {
      timeoutMs: 5000,
      maxResponseBytes: 8192,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            result: {
              content: [{ type: "text", text: key }],
              structuredContent: { key },
            },
          }),
        ),
    });
    const result = await Effect.runPromise(
      mcp
        .callTool("search", { query: key }, [key])
        .pipe(Effect.provideService(Tracer.Tracer, tracer)),
    );
    expect(result.text).toStrictEqual([key]);
    const direct = publicWebClientWith({
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      fetchImpl: async () => new Response(key, { headers: { "x-reflection": key } }),
    });
    const page = await Effect.runPromise(
      direct.get(pageRequest(key)).pipe(Effect.provideService(Tracer.Tracer, tracer)),
    );
    expect(page.body.toString()).toBe(key);
    expect(page.headers.get("x-reflection")).toBe(key);
    expect(spans.map((span) => span.name)).toStrictEqual([
      "ProviderHttpClient.getJson",
      "ProviderHttpClient.postJson",
      "McpClient.callTool",
      "PublicWebClient.get",
    ]);
    expect(exportedSpans(spans)).not.toContain(key);
    for (const span of spans) {
      expect(span.status).toMatchObject({ _tag: "Ended", exit: Exit.succeed(undefined) });
    }
  });

  test("FetchPage and PublicWebClient success spans exclude reflected body, MIME and status text", async () => {
    const key = "synthetic-page-reflection-key";
    const { spans, tracer } = recordingTracer();
    const client = publicWebClientWith({
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      fetchImpl: async () =>
        new Response(key, {
          status: 200,
          statusText: key,
          headers: { "content-type": `text/${key}` },
        }),
    });
    const fetchPage = fetchPageWith(client);
    const result = await Effect.runPromise(
      fetchPage
        .fetch({ url: pageRequest(key).url, format: "text" }, pageRequest(key))
        .pipe(Effect.provideService(Tracer.Tracer, tracer)),
    );
    expect(inspect(result, { depth: null })).toContain(key);
    expect(spans.map((span) => span.name)).toStrictEqual([
      "FetchPage.fetch",
      "PublicWebClient.get",
    ]);
    expect(exportedSpans(spans)).not.toContain(key);
    for (const span of spans) {
      expect(span.status).toMatchObject({ _tag: "Ended", exit: Exit.succeed(undefined) });
    }
  });

  test("FetchPage failure spans exclude reflected unsupported MIME and rejected status text", async () => {
    const key = "synthetic-page-failure-key";
    for (const response of [
      new Response(key, { headers: { "content-type": `application/${key}` } }),
      new Response(null, { status: 503, statusText: key }),
    ]) {
      const { spans, tracer } = recordingTracer();
      const client = publicWebClientWith({
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
        fetchImpl: async () => response,
      });
      const exit = await Effect.runPromiseExit(
        fetchPageWith(client)
          .fetch({ url: pageRequest(key).url, format: "text" }, pageRequest(key))
          .pipe(Effect.provideService(Tracer.Tracer, tracer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(inspect(exit, { depth: null })).toContain(key);
      expect(exportedSpans(spans)).not.toContain(key);
    }
  });

  test("direct page failures retain DNS/TLS diagnostics but never reflected causes in telemetry", async () => {
    const key = "synthetic-direct-failure-key";
    for (const code of ["ENOTFOUND", "CERT_HAS_EXPIRED"]) {
      for (const streamFailure of [false, true]) {
        const { spans, tracer } = recordingTracer();
        const client = publicWebClientWith({
          lookup: async () => [{ address: "8.8.8.8", family: 4 }],
          fetchImpl: reflectingFetch(
            streamFailure,
            key,
            Object.assign(new Error(key), { code, payload: key }),
          ),
        });
        const exit = await Effect.runPromiseExit(
          client.get(pageRequest(key)).pipe(Effect.provideService(Tracer.Tracer, tracer)),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(inspect(exit, { depth: null })).toContain(code);
        expect(inspect(exit, { depth: null })).not.toContain(key);
        expect(exportedSpans(spans)).toContain(code);
        expect(exportedSpans(spans)).not.toContain(key);
      }
    }
  });

  test("direct rejected status reflection is excluded from span errors", async () => {
    const key = "synthetic-status-key";
    const { spans, tracer } = recordingTracer();
    const client = publicWebClientWith({
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      fetchImpl: async () => new Response(null, { status: 503, statusText: key }),
    });
    const exit = await Effect.runPromiseExit(
      client.get(pageRequest(key)).pipe(Effect.provideService(Tracer.Tracer, tracer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(exportedSpans(spans)).not.toContain(key);
  });

  test("safe spans keep defects private and preserve caller exits", async () => {
    const key = "synthetic-defect-key";
    const { spans, tracer } = recordingTracer();
    const exit = await Effect.runPromiseExit(
      withSafeSpan("defect-test", Effect.die(new Error(key))).pipe(
        Effect.provideService(Tracer.Tracer, tracer),
      ),
    );
    expect(inspect(exit, { depth: null })).toContain(key);
    expect(exportedSpans(spans)).not.toContain(key);
  });

  test("safe HTTP spans promptly abort interrupted requests and export interruption", async () => {
    const { spans, tracer } = recordingTracer();
    const abort = new AbortController();
    const started = Promise.withResolvers<undefined>();
    let aborted = false;
    const client = providerHttpWith(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("synthetic-interruption-key"));
          });
          started.resolve(undefined);
        }),
    );
    const running = Effect.runPromiseExit(
      client
        .getJson({
          url: "https://api.example/search",
          headers: {},
          maxResponseBytes: 8192,
          timeout: Duration.seconds(60),
        })
        .pipe(Effect.provideService(Tracer.Tracer, tracer)),
      { signal: abort.signal },
    );
    await started.promise;
    abort.abort();
    const exit = await running;
    expect(aborted).toBe(true);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(exportedSpans(spans)).toContain("Interrupt");
    expect(exportedSpans(spans)).not.toContain("synthetic-interruption-key");
  });

  test("output store spans do not annotate content arguments", async () => {
    const { spans, tracer } = recordingTracer();
    const key = "synthetic-output-key";
    const path = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ToolOutputStore;
        return yield* store.writeTextFile("pi-telemetry-", "output.txt", key);
      }).pipe(Effect.provide(ToolOutputStore.layer), Effect.provideService(Tracer.Tracer, tracer)),
    );
    try {
      expect(spans.map((span) => span.name)).toContain("ToolOutputStore.writeTextFile");
      expect(exportedSpans(spans)).not.toContain(key);
    } finally {
      await rm(dirname(path), { recursive: true, force: true });
    }
  });
});

function reflectingFetch(streamFailure: boolean, key: string, error: Error): typeof fetch {
  return async () => {
    if (!streamFailure) {
      throw new TypeError(key, { cause: error });
    }
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.error(error);
        },
      }),
    );
  };
}

function reflectedMcpResponse(calls: number, text: string, rpc: boolean): Response {
  const payload = rpc
    ? { error: { message: text } }
    : { result: { isError: true, content: [{ type: "text", text }] } };
  return new Response(JSON.stringify(calls < 3 ? { result: {} } : payload));
}

function pageRequest(key: string) {
  return {
    url: publicUrl(`https://example.com/page?key=${key}`),
    accept: "text/plain",
    userAgent: "test",
    fallbackUserAgent: "test",
    maxRedirects: 3,
    maxResponseBytes: 8192,
    blockPrivateHosts: true,
    domainPolicy: { allow: [], deny: [] },
  };
}
