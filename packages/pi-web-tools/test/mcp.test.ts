import { assert, describe, expect, it, test } from "@effect/vitest";
import { Cause, Duration, Effect, Exit, Fiber, Option, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import { parseMcpMessage, parseMcpToolResult } from "../mcp";
import { ProviderProtocolInvalid, ProviderToolError } from "../provider-types";
import { publicUrl, mcpClientWith } from "./fakes";

const ENDPOINT = publicUrl("https://mcp.example/mcp");

function protocolInvalid(reason: string) {
  return Result.fail(new ProviderProtocolInvalid({ reason }));
}

describe("parseMcpMessage", () => {
  test("parses plain JSON responses", () => {
    expect(
      parseMcpMessage('{"jsonrpc":"2.0","id":2,"result":{}}', "application/json"),
    ).toStrictEqual(Result.succeed({ jsonrpc: "2.0", id: 2, result: {} }));
  });

  test("joins an SSE event's multi-line data and ignores non-data fields", () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0",\ndata: "id":2,"result":{}}\n\n';
    expect(parseMcpMessage(body, "text/event-stream")).toStrictEqual(
      Result.succeed({ jsonrpc: "2.0", id: 2, result: {} }),
    );
  });

  test("picks the last event carrying a result or error among notifications and noise", () => {
    const events = [
      '{"jsonrpc":"2.0","method":"notifications/progress"}',
      '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"first"}]}}',
      "not-json",
      '{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"late"}}',
      '{"jsonrpc":"2.0","method":"notifications/message"}',
      "[1,2]",
    ];
    const body = events.map((event) => `event: message\ndata: ${event}\n\n`).join("");

    expect(parseMcpMessage(body, "text/event-stream")).toStrictEqual(
      Result.succeed({ jsonrpc: "2.0", id: 2, error: { code: -32_000, message: "late" } }),
    );
    // A data: line marks SSE framing even under a JSON content type.
    expect(parseMcpMessage(body, "application/json")._tag).toBe("Success");
  });

  test("keeps a distinct reason for each missing or malformed response", () => {
    expect(parseMcpMessage("data: not-json\n\n", "text/event-stream")).toStrictEqual(
      protocolInvalid("Invalid JSON in SSE stream"),
    );
    expect(
      parseMcpMessage('data: {"jsonrpc":"2.0","method":"ping"}\n\n', "text/event-stream"),
    ).toStrictEqual(protocolInvalid("No JSON-RPC response in SSE stream"));
    expect(parseMcpMessage("   ", "application/json")).toStrictEqual(
      protocolInvalid("Empty response body"),
    );
    expect(parseMcpMessage("{broken", "application/json")).toStrictEqual(
      protocolInvalid("Invalid JSON response"),
    );
  });
});

describe("parseMcpToolResult", () => {
  test("extracts text items and structured content", () => {
    const result = parseMcpToolResult({
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [
          { type: "text", text: "hello" },
          { type: "image", data: "x" },
          { type: "text", text: "  " },
        ],
        structuredContent: { results: [] },
      },
    });
    assert(Result.isSuccess(result));
    expect(result.success.text).toStrictEqual(["hello"]);
    expect(result.success.structuredContent).toStrictEqual({ results: [] });
  });

  test("names why a payload is malformed", () => {
    expect(parseMcpToolResult(null)).toStrictEqual(protocolInvalid("Expected an object payload"));
    expect(parseMcpToolResult({ jsonrpc: "2.0", id: 2 })).toStrictEqual(
      protocolInvalid("Missing result object"),
    );
    expect(parseMcpToolResult([{ result: {} }])).toStrictEqual(
      protocolInvalid("Expected an object payload"),
    );
    expect(parseMcpToolResult({ result: [] })).toStrictEqual(
      protocolInvalid("Missing result object"),
    );
    expect(parseMcpToolResult({ result: "done" })).toStrictEqual(
      protocolInvalid("Missing result object"),
    );
  });

  test("tolerates wrong-typed fields and drops unusable content items", () => {
    const result = parseMcpToolResult({
      // Only an error object marks a JSON-RPC failure.
      error: "not an object",
      result: {
        isError: "true",
        content: [
          null,
          "text",
          { type: "text" },
          { type: "text", text: 5 },
          { type: "resource", text: "not text content" },
          { type: "text", text: "  kept  " },
        ],
      },
    });
    expect(result).toStrictEqual(Result.succeed({ text: ["kept"], structuredContent: undefined }));

    expect(parseMcpToolResult({ result: { content: "not an array" } })).toStrictEqual(
      Result.succeed({ text: [], structuredContent: undefined }),
    );
    expect(parseMcpToolResult({ error: {}, result: { content: [] } })).toStrictEqual(
      Result.fail(new ProviderToolError({ detail: "" })),
    );
  });
});

function jsonResponse(
  body: unknown,
  init: { readonly status?: number; readonly headers?: Readonly<Record<string, string>> } = {},
): Response {
  return Response.json(body, { status: init.status ?? 200, headers: init.headers ?? {} });
}

const decodeRpcRequest = Schema.decodeUnknownOption(Schema.Struct({ method: Schema.String }));

/** One request the fake MCP endpoint received. */
type RecordedRequest = {
  readonly httpMethod: string;
  readonly sessionId: string | null;
  readonly rpcMethod: string | undefined;
};

/** The JSON-RPC method of a request body, when it is one. */
function rpcMethodOf(body: unknown): string | undefined {
  if (typeof body !== "string") {
    return undefined;
  }
  return Option.getOrUndefined(
    Option.map(decodeRpcRequest(JSON.parse(body)), (request) => request.method),
  );
}

/**
 * A fake MCP endpoint. It answers DELETE with 200 and a POST from the reply for its JSON-RPC
 * method, or `otherwise`, and records every request.
 */
function fakeMcpEndpoint(
  replies: Readonly<Record<string, () => Response>>,
  otherwise: () => Response,
) {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const httpMethod = init?.method ?? "GET";
    const rpcMethod = rpcMethodOf(init?.body);
    requests.push({
      httpMethod,
      sessionId: new Headers(init?.headers).get("mcp-session-id"),
      rpcMethod,
    });
    if (httpMethod === "DELETE") {
      return new Response(null, { status: 200 });
    }
    return (replies[rpcMethod ?? ""] ?? otherwise)();
  };
  return { fetchImpl, requests };
}

const tooManyRequests: typeof fetch = async () => new Response("nope", { status: 429 });

const connectionRefused: typeof fetch = async () => {
  throw new Error("connection refused");
};

const toolCallReply = (text: string) => () =>
  jsonResponse({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text }] } });

describe("mcpHttpClient", () => {
  it.effect(
    "runs initialize, initialized, tools/call with the session header and closes the session",
    () =>
      Effect.gen(function* () {
        const { fetchImpl, requests } = fakeMcpEndpoint(
          {
            initialize: () =>
              jsonResponse(
                {
                  jsonrpc: "2.0",
                  id: 1,
                  result: {
                    protocolVersion: "2025-06-18",
                    capabilities: {},
                    serverInfo: { name: "fake", version: "1" },
                  },
                },
                { headers: { "mcp-session-id": "session-123" } },
              ),
            "notifications/initialized": () => new Response(null, { status: 202 }),
          },
          toolCallReply("found it"),
        );

        const client = mcpClientWith(ENDPOINT, {
          maxResponseBytes: 1024 * 1024,
          timeoutMs: 5000,
          fetchImpl,
        });
        const result = yield* Effect.result(client.callTool("web_search", { objective: "test" }));

        assert(Result.isSuccess(result));
        expect(result.success.text).toStrictEqual(["found it"]);
        expect(requests.map((request) => request.httpMethod)).toStrictEqual([
          "POST",
          "POST",
          "POST",
          "DELETE",
        ]);
        // The initialize POST has no session header; subsequent calls carry it.
        expect(requests[0]?.sessionId).toBeNull();
        expect(requests[1]?.sessionId).toBe("session-123");
        expect(requests[2]?.sessionId).toBe("session-123");
      }),
  );

  it.effect("maps non-2xx initialize responses to ProviderStatusRejected", () =>
    Effect.gen(function* () {
      const client = mcpClientWith(ENDPOINT, {
        maxResponseBytes: 1024,
        timeoutMs: 5000,
        fetchImpl: tooManyRequests,
      });
      const result = yield* Effect.result(client.callTool("web_search", {}));
      assert(Result.isFailure(result));
      assert(result.failure._tag === "ProviderStatusRejected");
      expect(result.failure.status).toBe(429);
      expect(result.failure.message).toBe("rejected (HTTP 429)");
    }),
  );

  it.effect("continues when the initialized notification is rejected", () =>
    Effect.gen(function* () {
      const { fetchImpl } = fakeMcpEndpoint(
        {
          initialize: () => jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }),
          "notifications/initialized": () => new Response("bad", { status: 400 }),
        },
        toolCallReply("ok"),
      );
      const client = mcpClientWith(ENDPOINT, {
        maxResponseBytes: 1024,
        timeoutMs: 5000,
        fetchImpl,
      });
      const result = yield* Effect.result(client.callTool("web_search", {}));
      expect(result._tag).toBe("Success");
    }),
  );

  it.effect("maps fetch failures to ProviderRequestFailed", () =>
    Effect.gen(function* () {
      const client = mcpClientWith(ENDPOINT, {
        maxResponseBytes: 1024,
        timeoutMs: 5000,
        fetchImpl: connectionRefused,
      });
      const result = yield* Effect.result(client.callTool("web_search", {}));
      assert(Result.isFailure(result));
      assert(result.failure._tag === "ProviderRequestFailed");
      expect(result.failure.hostname).toBe("mcp.example");
      expect(result.failure.message).toBe("request to mcp.example failed");
    }),
  );
});

/** The detail and message of the ProviderToolError a payload parses to. */
function detailOf(payload: unknown, secrets: readonly string[] = []) {
  const result = parseMcpToolResult(payload, secrets);
  assert(Result.isFailure(result));
  assert(result.failure._tag === "ProviderToolError");
  return { detail: result.failure.detail, message: result.failure.message };
}

describe("provider tool error detail", () => {
  test("takes the JSON-RPC error message", () => {
    expect(detailOf({ error: { code: -1, message: "rate limited" } })).toStrictEqual({
      detail: "rate limited",
      message: "reported an error: rate limited",
    });
  });

  test("takes the text content of an isError result", () => {
    const payload = {
      result: {
        isError: true,
        content: [
          { type: "text", text: "quota" },
          { type: "text", text: "exceeded" },
        ],
      },
    };
    expect(detailOf(payload).detail).toBe("quota exceeded");
  });

  test("collapses whitespace", () => {
    expect(detailOf({ error: { message: "  a\n\n b\t\tc  " } }).detail).toBe("a b c");
  });

  test("truncates to 200 characters", () => {
    const { detail } = detailOf({ error: { message: "x".repeat(500) } });
    expect(detail).toHaveLength(200);
    expect(detail.endsWith("...")).toBe(true);
  });

  test("redacts secrets, even ones straddling the truncation point", () => {
    expect(detailOf({ error: { message: "bad key sk-123 here" } }, ["sk-123"]).detail).toBe(
      "bad key [redacted] here",
    );
    const straddling = `${"y".repeat(195)} sk-123456789`;
    const { detail } = detailOf({ error: { message: straddling } }, ["sk-123456789"]);
    expect(detail).not.toContain("sk-");
  });

  test("an empty detail renders without a colon", () => {
    expect(detailOf({ error: { message: "   " } })).toStrictEqual({
      detail: "",
      message: "reported an error",
    });
    expect(detailOf({ result: { isError: true, content: [] } }).message).toBe("reported an error");
  });
});

const initializeWithSession = () =>
  jsonResponse(
    { jsonrpc: "2.0", id: 1, result: {} },
    { headers: { "mcp-session-id": "session-9" } },
  );
const initializedAccepted = () => new Response(null, { status: 202 });
const HANDSHAKE = {
  initialize: initializeWithSession,
  "notifications/initialized": initializedAccepted,
};

function deletes(requests: readonly RecordedRequest[]) {
  return requests.filter((request) => request.httpMethod === "DELETE");
}

/**
 * Wrap a fake endpoint so tools/call never answers; `onHang` runs when it is sent. Every other
 * request goes to `fetchImpl`.
 */
function hangingToolsCall(fetchImpl: typeof fetch, onHang: () => void = () => undefined) {
  const wrapped: typeof fetch = async (input, init) => {
    if (rpcMethodOf(init?.body) !== "tools/call") {
      return fetchImpl(input, init);
    }
    onHang();
    return new Promise<Response>(() => {
      // Never settles.
    });
  };
  return wrapped;
}

describe("mcpHttpClient session cleanup", () => {
  it.effect("closes the session when tools/call is rejected", () =>
    Effect.gen(function* () {
      const { fetchImpl, requests } = fakeMcpEndpoint(
        HANDSHAKE,
        () => new Response("boom", { status: 500 }),
      );
      const client = mcpClientWith(ENDPOINT, {
        maxResponseBytes: 1024,
        timeoutMs: 5000,
        fetchImpl,
      });
      const result = yield* Effect.result(client.callTool("web_search", {}));
      assert(Result.isFailure(result));
      expect(result.failure.message).toBe("rejected (HTTP 500)");
      expect(deletes(requests)).toStrictEqual([
        { httpMethod: "DELETE", sessionId: "session-9", rpcMethod: undefined },
      ]);
    }),
  );

  it.effect("closes the session when tools/call times out", () =>
    Effect.gen(function* () {
      const { fetchImpl, requests } = fakeMcpEndpoint(HANDSHAKE, toolCallReply("unused"));
      const hanging = hangingToolsCall(fetchImpl);
      const client = mcpClientWith(ENDPOINT, {
        maxResponseBytes: 1024,
        timeoutMs: 30,
        fetchImpl: hanging,
      });
      const fiber = yield* Effect.forkChild(Effect.result(client.callTool("web_search", {})));
      yield* TestClock.adjust(Duration.millis(30));
      const result = yield* Fiber.join(fiber);
      assert(Result.isFailure(result));
      expect(result.failure.message).toBe("timed out after 1s");
      expect(deletes(requests)).toHaveLength(1);
    }),
  );

  test("closes the session when the caller interrupts tools/call", async () => {
    const controller = new AbortController();
    const { fetchImpl, requests } = fakeMcpEndpoint(HANDSHAKE, toolCallReply("unused"));
    const hanging = hangingToolsCall(fetchImpl, () => {
      controller.abort();
    });
    const client = mcpClientWith(ENDPOINT, {
      maxResponseBytes: 1024,
      timeoutMs: 5000,
      fetchImpl: hanging,
    });
    const exit = await Effect.runPromiseExit(client.callTool("web_search", {}), {
      signal: controller.signal,
    });
    assert(Exit.isFailure(exit));
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(deletes(requests)).toHaveLength(1);
  });
});
