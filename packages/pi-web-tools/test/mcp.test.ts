import { describe, expect, test } from "vitest";
import { McpHttpClient, parseMcpMessage, parseMcpToolResult, parseSseDataLines } from "../mcp";
import { err, ok } from "../result";
import type { PublicHttpUrl } from "../types";

const ENDPOINT = "https://mcp.example/mcp" as PublicHttpUrl;

describe("parseSseDataLines", () => {
  test("collects multi-line data chunks separated by blank lines", () => {
    const input = 'data: {"a":1}\n\ndata: {"b":\ndata: 2}\n\nevent: ignored\ndata: {"c":3}\n';
    expect(parseSseDataLines(input)).toEqual(['{"a":1}', '{"b":\n2}', '{"c":3}']);
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

    expect(parseMcpMessage(body, "text/event-stream")).toEqual(
      ok({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "late" } }),
    );
    // A data: line marks SSE framing even under a JSON content type.
    expect(parseMcpMessage(body, "application/json")._tag).toBe("ok");
  });

  test("keeps a distinct reason for each missing or malformed response", () => {
    const invalid = (reason: string) => err({ _tag: "ProviderProtocolInvalid", reason });
    expect(parseMcpMessage("data: not-json\n\n", "text/event-stream")).toEqual(
      invalid("Invalid JSON in SSE stream"),
    );
    expect(
      parseMcpMessage('data: {"jsonrpc":"2.0","method":"ping"}\n\n', "text/event-stream"),
    ).toEqual(invalid("No JSON-RPC response in SSE stream"));
    expect(parseMcpMessage("   ", "application/json")).toEqual(invalid("Empty response body"));
    expect(parseMcpMessage("{broken", "application/json")).toEqual(
      invalid("Invalid JSON response"),
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
    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(result.value.text).toEqual(["hello"]);
    expect(result.value.structuredContent).toEqual({ results: [] });
  });

  test("maps JSON-RPC errors and isError results to ProviderToolError", () => {
    const rpcError = parseMcpToolResult({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -1, message: "x" },
    });
    expect(rpcError._tag).toBe("err");
    if (rpcError._tag !== "err") return;
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
    const invalid = (reason: string) => err({ _tag: "ProviderProtocolInvalid", reason });
    expect(parseMcpToolResult([{ result: {} }])).toEqual(invalid("Expected an object payload"));
    expect(parseMcpToolResult({ result: [] })).toEqual(invalid("Missing result object"));
    expect(parseMcpToolResult({ result: "done" })).toEqual(invalid("Missing result object"));
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
    expect(result).toEqual(ok({ text: ["kept"], structuredContent: undefined }));

    expect(parseMcpToolResult({ result: { content: "not an array" } })).toEqual(
      ok({ text: [], structuredContent: undefined }),
    );
    expect(parseMcpToolResult({ error: {}, result: { content: [] } })).toEqual(
      err({ _tag: "ProviderToolError" }),
    );
  });
});

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: new Headers({ "content-type": "application/json", ...init.headers }),
  });
}

describe("McpHttpClient", () => {
  test("runs initialize, initialized, tools/call with the session header and closes the session", async () => {
    const methods: string[] = [];
    const sessionHeaders: (string | null)[] = [];
    const fetchImpl = ((_input: unknown, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      sessionHeaders.push(new Headers(init?.headers).get("mcp-session-id"));
      if (method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      const payload = JSON.parse(String(init?.body)) as { method: string };
      if (payload.method === "initialize") {
        return Promise.resolve(
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
        );
      }
      if (payload.method === "notifications/initialized") {
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      return Promise.resolve(
        jsonResponse({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: "found it" }] },
        }),
      );
    }) as typeof fetch;

    const client = new McpHttpClient(ENDPOINT, {
      maxResponseBytes: 1024 * 1024,
      timeoutMs: 5_000,
      fetchImpl,
    });
    const result = await client.callTool("web_search", { objective: "test" });

    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(result.value.text).toEqual(["found it"]);
    expect(methods).toEqual(["POST", "POST", "POST", "DELETE"]);
    // The initialize POST has no session header; subsequent calls carry it.
    expect(sessionHeaders[0]).toBeNull();
    expect(sessionHeaders[1]).toBe("session-123");
    expect(sessionHeaders[2]).toBe("session-123");
  });

  test("maps non-2xx initialize responses to ProviderStatusRejected", async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response("nope", { status: 429 }))) as typeof fetch;
    const client = new McpHttpClient(ENDPOINT, {
      maxResponseBytes: 1024,
      timeoutMs: 5_000,
      fetchImpl,
    });
    const result = await client.callTool("web_search", {});
    expect(result._tag).toBe("err");
    if (result._tag !== "err") return;
    expect(result.error).toEqual({ _tag: "ProviderStatusRejected", status: 429 });
  });

  test("continues when the initialized notification is rejected", async () => {
    const fetchImpl = ((_input: unknown, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { method: string };
      if (payload.method === "initialize") {
        return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }));
      }
      if (payload.method === "notifications/initialized") {
        return Promise.resolve(new Response("bad", { status: 400 }));
      }
      return Promise.resolve(
        jsonResponse({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: "ok" }] },
        }),
      );
    }) as typeof fetch;
    const client = new McpHttpClient(ENDPOINT, {
      maxResponseBytes: 1024,
      timeoutMs: 5_000,
      fetchImpl,
    });
    const result = await client.callTool("web_search", {});
    expect(result._tag).toBe("ok");
  });

  test("maps fetch failures to ProviderRequestFailed", async () => {
    const fetchImpl = (() => Promise.reject(new Error("connection refused"))) as typeof fetch;
    const client = new McpHttpClient(ENDPOINT, {
      maxResponseBytes: 1024,
      timeoutMs: 5_000,
      fetchImpl,
    });
    const result = await client.callTool("web_search", {});
    expect(result).toEqual({ _tag: "err", error: { _tag: "ProviderRequestFailed" } });
  });
});
