import { assert, describe, expect, test } from "vitest";
import { z } from "zod";
import { McpHttpClient, parseMcpMessage, parseMcpToolResult, parseSseDataLines } from "../mcp";
import { err, ok } from "../result";
import { publicUrl } from "./fakes";

const ENDPOINT = publicUrl("https://mcp.example/mcp");

function protocolInvalid(reason: string) {
  return err({ _tag: "ProviderProtocolInvalid", reason });
}

describe("parseSseDataLines", () => {
  test("collects multi-line data chunks separated by blank lines", () => {
    const input = 'data: {"a":1}\n\ndata: {"b":\ndata: 2}\n\nevent: ignored\ndata: {"c":3}\n';
    expect(parseSseDataLines(input)).toStrictEqual(['{"a":1}', '{"b":\n2}', '{"c":3}']);
  });
});

describe("parseMcpMessage", () => {
  test("parses plain JSON responses", () => {
    const result = parseMcpMessage('{"jsonrpc":"2.0","id":2,"result":{}}', "application/json");
    expect(result._tag).toBe("ok");
  });

  test("takes the last JSON-RPC response from an SSE stream", () => {
    const body = 'data: {"jsonrpc":"2.0","id":2,"result":{"content":[]}}\n\n';
    const result = parseMcpMessage(body, "text/event-stream");
    expect(result._tag).toBe("ok");
  });

  test("skips malformed SSE chunks without failing the batch", () => {
    const body = 'data: not-json\n\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[]}}\n\n';
    const result = parseMcpMessage(body, "text/event-stream");
    expect(result._tag).toBe("ok");
  });

  test("fails when the stream has no JSON-RPC response", () => {
    expect(parseMcpMessage("data: not-json\n\n", "text/event-stream")._tag).toBe("err");
    expect(parseMcpMessage("", "application/json")._tag).toBe("err");
    expect(parseMcpMessage("{broken", "application/json")._tag).toBe("err");
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
      ok({ jsonrpc: "2.0", id: 2, error: { code: -32_000, message: "late" } }),
    );
    // A data: line marks SSE framing even under a JSON content type.
    expect(parseMcpMessage(body, "application/json")._tag).toBe("ok");
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
    assert(result._tag === "ok");
    expect(result.value.text).toStrictEqual(["hello"]);
    expect(result.value.structuredContent).toStrictEqual({ results: [] });
  });

  test("maps JSON-RPC errors and isError results to ProviderToolError", () => {
    const rpcError = parseMcpToolResult({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -1, message: "x" },
    });
    assert(rpcError._tag === "err");
    expect(rpcError.error._tag).toBe("ProviderToolError");

    const toolError = parseMcpToolResult({
      jsonrpc: "2.0",
      id: 2,
      result: { isError: true, content: [] },
    });
    expect(toolError._tag).toBe("err");
  });

  test("rejects malformed payloads", () => {
    expect(parseMcpToolResult(null)._tag).toBe("err");
    expect(parseMcpToolResult({ jsonrpc: "2.0", id: 2 })._tag).toBe("err");
  });

  test("names why a payload is malformed", () => {
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
    expect(result).toStrictEqual(ok({ text: ["kept"], structuredContent: undefined }));

    expect(parseMcpToolResult({ result: { content: "not an array" } })).toStrictEqual(
      ok({ text: [], structuredContent: undefined }),
    );
    expect(parseMcpToolResult({ error: {}, result: { content: [] } })).toStrictEqual(
      err({ _tag: "ProviderToolError" }),
    );
  });
});

function jsonResponse(
  body: unknown,
  init: { readonly status?: number; readonly headers?: Readonly<Record<string, string>> } = {},
): Response {
  return Response.json(body, { status: init.status ?? 200, headers: init.headers ?? {} });
}

const rpcRequestSchema = z.object({ method: z.string() });

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
  const parsed = rpcRequestSchema.safeParse(JSON.parse(body));
  return parsed.success ? parsed.data.method : undefined;
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
  test("runs initialize, initialized, tools/call with the session header and closes the session", async () => {
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

    const client = new McpHttpClient(ENDPOINT, {
      maxResponseBytes: 1024 * 1024,
      timeoutMs: 5000,
      fetchImpl,
    });
    const result = await client.callTool("web_search", { objective: "test" });

    assert(result._tag === "ok");
    expect(result.value.text).toStrictEqual(["found it"]);
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
  });

  test("maps non-2xx initialize responses to ProviderStatusRejected", async () => {
    const client = new McpHttpClient(ENDPOINT, {
      maxResponseBytes: 1024,
      timeoutMs: 5000,
      fetchImpl: tooManyRequests,
    });
    const result = await client.callTool("web_search", {});
    assert(result._tag === "err");
    expect(result.error).toStrictEqual({ _tag: "ProviderStatusRejected", status: 429 });
  });

  test("continues when the initialized notification is rejected", async () => {
    const { fetchImpl } = fakeMcpEndpoint(
      {
        initialize: () => jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }),
        "notifications/initialized": () => new Response("bad", { status: 400 }),
      },
      toolCallReply("ok"),
    );
    const client = new McpHttpClient(ENDPOINT, {
      maxResponseBytes: 1024,
      timeoutMs: 5000,
      fetchImpl,
    });
    const result = await client.callTool("web_search", {});
    expect(result._tag).toBe("ok");
  });

  test("maps fetch failures to ProviderRequestFailed", async () => {
    const client = new McpHttpClient(ENDPOINT, {
      maxResponseBytes: 1024,
      timeoutMs: 5000,
      fetchImpl: connectionRefused,
    });
    const result = await client.callTool("web_search", {});
    expect(result).toStrictEqual({ _tag: "err", error: { _tag: "ProviderRequestFailed" } });
  });
});
