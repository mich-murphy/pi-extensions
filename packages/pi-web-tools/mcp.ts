import { z } from "zod";
import { createOperationSignal, isAbortError, readResponseBodyWithLimit } from "./network";
import { classifyProviderAbort, lenientArray, parseJsonBody } from "./provider-types";
import type { ProviderError } from "./provider-types";
import { err, ok } from "./result";
import type { Result } from "./result";
import type { PublicHttpUrl } from "./types";
import { WEB_TOOLS_VERSION } from "./types";

/** MCP protocol revision spoken by this client (Streamable HTTP). */
const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Extracted payload of a successful MCP tools/call. */
export type McpToolCallResult = {
  readonly text: readonly string[];
  readonly structuredContent?: unknown;
};

/** Outbound port for MCP tool calls. */
export type McpClient = {
  readonly callTool: (
    name: string,
    args: Readonly<Record<string, unknown>>,
    options?: { readonly signal?: AbortSignal | undefined },
  ) => Promise<Result<McpToolCallResult, ProviderError>>;
};

type McpPostOutcome = {
  readonly sessionId: string | null;
  readonly bodyText: string;
  readonly contentType: string;
};

/**
 * Minimal MCP Streamable HTTP client.
 *
 * Speaks the official handshake — initialize, notifications/initialized,
 * tools/call — honoring the Mcp-Session-Id header and both JSON and SSE
 * response framings, then closes the session with DELETE. One session per
 * tool call keeps the client stateless between calls.
 */
export class McpHttpClient implements McpClient {
  constructor(
    private readonly endpoint: PublicHttpUrl,
    private readonly options: {
      readonly headers?: Readonly<Record<string, string>>;
      readonly maxResponseBytes: number;
      readonly timeoutMs: number;
      readonly fetchImpl?: typeof fetch;
    },
  ) {}

  /** Run a full MCP session for a single tool call. */
  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<Result<McpToolCallResult, ProviderError>> {
    const composed = createOperationSignal(this.options.timeoutMs, options.signal);
    let sessionId: string | null = null;
    try {
      const init = await this.post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "pi-web-tools", version: WEB_TOOLS_VERSION },
          },
        },
        sessionId,
        composed.signal,
      );
      if (init._tag === "err") {
        return init;
      }
      ({ sessionId } = init.value);

      const initialized = await this.post(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        sessionId,
        composed.signal,
      );
      // A rejected notification does not invalidate the session on all servers; proceed.
      if (initialized._tag === "err" && initialized.error._tag !== "ProviderStatusRejected") {
        return initialized;
      }

      const call = await this.post(
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
        sessionId,
        composed.signal,
      );
      if (call._tag === "err") {
        return call;
      }

      const message = parseMcpMessage(call.value.bodyText, call.value.contentType);
      if (message._tag === "err") {
        return message;
      }
      return parseMcpToolResult(message.value);
    } finally {
      composed.cleanup();
      if (sessionId !== null && sessionId !== "") {
        await this.closeSession(sessionId);
      }
    }
  }

  private async post(
    payload: Readonly<Record<string, unknown>>,
    sessionId: string | null,
    signal: AbortSignal,
  ): Promise<Result<McpPostOutcome, ProviderError>> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.options.headers,
    };
    if (sessionId !== null && sessionId !== "") {
      headers["mcp-session-id"] = sessionId;
    }

    let response: Response;
    try {
      response = await fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error: unknown) {
      if (signal.aborted || isAbortError(error)) {
        return err(classifyProviderAbort(signal));
      }
      return err({ _tag: "ProviderRequestFailed" });
    }

    const contentType = response.headers.get("content-type") ?? "";
    const body = await readResponseBodyWithLimit(response, this.options.maxResponseBytes, signal);
    if (body._tag === "err") {
      if (signal.aborted) {
        return err(classifyProviderAbort(signal));
      }
      if (body.error._tag === "BodyTooLarge") {
        return err({ _tag: "ProviderResponseTooLarge" });
      }
      return err({ _tag: "ProviderRequestFailed" });
    }

    if (response.status < 200 || response.status >= 300) {
      return err({ _tag: "ProviderStatusRejected", status: response.status });
    }

    return ok({
      sessionId: response.headers.get("mcp-session-id"),
      bodyText: body.value.toString("utf8"),
      contentType,
    });
  }

  private async closeSession(sessionId: string): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    try {
      await fetchImpl(this.endpoint, {
        method: "DELETE",
        headers: { "mcp-session-id": sessionId, ...this.options.headers },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Session close is best-effort; servers expire sessions on their own.
    }
  }
}

// A JSON-RPC response carries result or error; requests and notifications carry neither.
const jsonRpcResponseSchema = z
  .looseObject({})
  .refine((message) => "result" in message || "error" in message);

/** Parse an MCP HTTP response body (JSON or SSE framing) into a single JSON-RPC message. */
export function parseMcpMessage(body: string, contentType: string): Result<unknown, ProviderError> {
  if (contentType.toLowerCase().includes("text/event-stream") || /^data:/mu.test(body)) {
    return parseSseResponse(body);
  }
  if (!body.trim()) {
    return err({ _tag: "ProviderProtocolInvalid", reason: "Empty response body" });
  }
  return parseJsonBody(body);
}

/** Pick the last JSON-RPC response from an SSE stream; malformed events are skipped. */
function parseSseResponse(body: string): Result<unknown, ProviderError> {
  const events = parseSseDataLines(body).map((chunk) => parseJsonBody(chunk));
  const responses = events.filter(
    (event) => event._tag === "ok" && jsonRpcResponseSchema.safeParse(event.value).success,
  );
  const last = responses.at(-1);
  if (last !== undefined) {
    return last;
  }
  const sawInvalidJson = events.some((event) => event._tag === "err");
  return err({
    _tag: "ProviderProtocolInvalid",
    reason: sawInvalidJson ? "Invalid JSON in SSE stream" : "No JSON-RPC response in SSE stream",
  });
}

// Only text content is extracted; images, resources, and blank text are dropped.
const textContentSchema = z
  .object({ type: z.literal("text"), text: z.string() })
  .transform((item) => item.text.trim() || undefined);

const toolCallResponseSchema = z.object({
  // Only an error object marks a JSON-RPC failure; any other error value is ignored.
  error: z.object({}).optional().catch(undefined),
  result: z
    .object({
      isError: z.boolean().catch(false),
      content: lenientArray(textContentSchema).catch([]),
      structuredContent: z.unknown().optional(),
    })
    .optional()
    .catch(undefined),
});

/** Extract text content and structured content from a JSON-RPC tools/call response. */
export function parseMcpToolResult(payload: unknown): Result<McpToolCallResult, ProviderError> {
  const parsed = toolCallResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return err({ _tag: "ProviderProtocolInvalid", reason: "Expected an object payload" });
  }
  const { error, result } = parsed.data;
  if (error !== undefined) {
    return err({ _tag: "ProviderToolError" });
  }
  if (result === undefined) {
    return err({ _tag: "ProviderProtocolInvalid", reason: "Missing result object" });
  }
  if (result.isError) {
    return err({ _tag: "ProviderToolError" });
  }
  return ok({ text: result.content, structuredContent: result.structuredContent });
}

/** Extract data payloads from an SSE event stream. */
export function parseSseDataLines(input: string): string[] {
  const lines = input.replaceAll("\r\n", "\n").split("\n");
  const chunks: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith("data:")) {
      current.push(line.slice(5).trim());
      continue;
    }
    if (!line.trim() && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [];
    }
  }

  if (current.length > 0) {
    chunks.push(current.join("\n"));
  }

  return chunks.filter((chunk) => chunk.trim().length > 0);
}
