import { Context, Duration, Effect, Layer, Result, Schema } from "effect";
import { HttpFetch } from "./network";
import { sendProviderRequest, withProviderDeadline } from "./provider-http";
import {
  lenientArray,
  orFallback,
  parseJsonBody,
  ProviderProtocolInvalid,
  ProviderStatusRejected,
  ProviderToolError,
} from "./provider-types";
import type { ProviderError } from "./provider-types";
import { SEARCH_MAX_RESPONSE_BYTES, SEARCH_TIMEOUT_SECONDS } from "./settings";
import { redactSecrets } from "./tool-output";
import type { PublicHttpUrl } from "./types";
import { WEB_TOOLS_VERSION } from "./types";

/** MCP protocol revision spoken by this client (Streamable HTTP). */
const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Extracted payload of a successful MCP tools/call. */
export type McpToolCallResult = {
  readonly text: readonly string[];
  readonly structuredContent?: unknown;
};

/** Outbound port for MCP tool calls. Interrupting a call aborts it; the session is still closed. */
export type McpClient = {
  readonly callTool: (
    name: string,
    args: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<McpToolCallResult, ProviderError>;
};

type McpPostOutcome = {
  readonly sessionId: string | null;
  readonly bodyText: string;
  readonly contentType: string;
};

/** How long the best-effort session DELETE may take. */
const CLOSE_SESSION_TIMEOUT_MS = 5000;

/** Bounds applied to every MCP tool call. */
type McpClientOptions = {
  readonly maxResponseBytes: number;
  /** Deadline for a whole session; ProviderTimedOut names it in whole seconds, rounded up. */
  readonly timeout: Duration.Duration;
};

/**
 * MCP clients keyed by endpoint. Endpoints come from settings at runtime, so clients are built on
 * demand and cached: every caller asking for one endpoint shares one client, which is safe because
 * each tool call opens a fresh session. Clients are keyless; keys never reach MCP endpoints.
 */
export class McpClients extends Context.Service<
  McpClients,
  {
    /** The shared client for an MCP Streamable HTTP endpoint. */
    readonly forEndpoint: (endpoint: PublicHttpUrl) => McpClient;
  }
>()("pi-web-tools/mcp/McpClients") {
  /**
   * A live layer over HttpFetch with the given bounds.
   *
   * @param options - The response byte cap and session deadline for every client.
   * @returns The McpClients layer.
   */
  static layerWith(options: {
    readonly maxResponseBytes: number;
    readonly timeout: Duration.Duration;
  }): Layer.Layer<McpClients, never, HttpFetch> {
    return Layer.effect(
      McpClients,
      Effect.gen(function* () {
        const http = yield* HttpFetch;
        const cache = new Map<PublicHttpUrl, McpClient>();
        const forEndpoint = (endpoint: PublicHttpUrl): McpClient => {
          const cached = cache.get(endpoint);
          if (cached !== undefined) {
            return cached;
          }
          const client = makeMcpHttpClient(http, endpoint, options);
          cache.set(endpoint, client);
          return client;
        };
        return McpClients.of({ forEndpoint });
      }),
    );
  }

  /** The live layer with the search response cap and the default search deadline. */
  static readonly layer = McpClients.layerWith({
    maxResponseBytes: SEARCH_MAX_RESPONSE_BYTES,
    timeout: Duration.seconds(SEARCH_TIMEOUT_SECONDS.default),
  });
}

/**
 * Minimal MCP Streamable HTTP client for one endpoint.
 *
 * Speaks the official handshake — initialize, notifications/initialized,
 * tools/call — honoring the Mcp-Session-Id header and both JSON and SSE
 * response framings, then closes the session with DELETE. One session per
 * tool call keeps the client stateless between calls.
 */
function makeMcpHttpClient(
  http: HttpFetch["Service"],
  endpoint: PublicHttpUrl,
  options: McpClientOptions,
): McpClient {
  const post = Effect.fnUntraced(function* (
    payload: Readonly<Record<string, unknown>>,
    sessionId: string | null,
  ): Effect.fn.Return<McpPostOutcome, ProviderError> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (sessionId !== null && sessionId !== "") {
      headers["mcp-session-id"] = sessionId;
    }
    const { response, bodyText } = yield* sendProviderRequest(
      http,
      endpoint,
      { method: "POST", headers, body: JSON.stringify(payload) },
      options.maxResponseBytes,
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new ProviderStatusRejected({ status: response.status });
    }
    return {
      sessionId: response.headers.get("mcp-session-id"),
      bodyText,
      contentType: response.headers.get("content-type") ?? "",
    };
  });

  // Best-effort: servers expire sessions on their own, so a failed DELETE is ignored.
  const closeSession = (sessionId: string): Effect.Effect<void> =>
    Effect.tryPromise(async () =>
      http.fetch(endpoint, {
        method: "DELETE",
        headers: { "mcp-session-id": sessionId },
        signal: AbortSignal.timeout(CLOSE_SESSION_TIMEOUT_MS),
      }),
    ).pipe(Effect.ignore);

  // Run a full MCP session for a single tool call; the session closes however the call ends.
  const callTool = Effect.fn("McpClient.callTool")(function* (
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Effect.fn.Return<McpToolCallResult, ProviderError> {
    let sessionId: string | null = null;
    const session = Effect.gen(function* () {
      const init = yield* post(
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
        null,
      );
      ({ sessionId } = init);

      // A rejected notification does not invalidate the session on all servers; proceed.
      yield* post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId).pipe(
        Effect.catchTag("ProviderStatusRejected", () => Effect.void),
      );

      const call = yield* post(
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
        sessionId,
      );
      const message = yield* Effect.fromResult(parseMcpMessage(call.bodyText, call.contentType));
      return yield* Effect.fromResult(parseMcpToolResult(message));
    });

    return yield* session.pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          sessionId === null || sessionId === "" ? Effect.void : closeSession(sessionId),
        ),
      ),
      withProviderDeadline(options.timeout),
    );
  });

  return { callTool };
}

// A JSON-RPC response carries result or error; requests and notifications carry neither.
const isJsonRpcResponse = Schema.is(
  Schema.Union([
    Schema.Struct({ result: Schema.Unknown }),
    Schema.Struct({ error: Schema.Unknown }),
  ]),
);

/** Parse an MCP HTTP response body (JSON or SSE framing) into a single JSON-RPC message. */
export function parseMcpMessage(
  body: string,
  contentType: string,
): Result.Result<unknown, ProviderError> {
  if (contentType.toLowerCase().includes("text/event-stream") || /^data:/mu.test(body)) {
    return parseSseResponse(body);
  }
  if (!body.trim()) {
    return Result.fail(new ProviderProtocolInvalid({ reason: "Empty response body" }));
  }
  return parseJsonBody(body);
}

/** Pick the last JSON-RPC response from an SSE stream; malformed events are skipped. */
function parseSseResponse(body: string): Result.Result<unknown, ProviderError> {
  const events = parseSseDataLines(body).map((chunk) => parseJsonBody(chunk));
  const responses = events.filter(
    (event) => Result.isSuccess(event) && isJsonRpcResponse(event.success),
  );
  const last = responses.at(-1);
  if (last !== undefined) {
    return last;
  }
  const sawInvalidJson = events.some((event) => Result.isFailure(event));
  return Result.fail(
    new ProviderProtocolInvalid({
      reason: sawInvalidJson ? "Invalid JSON in SSE stream" : "No JSON-RPC response in SSE stream",
    }),
  );
}

// Only text content is extracted; images and resources are dropped (blank text is dropped later).
const TextContent = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const decodeToolCallResponse = Schema.decodeUnknownResult(
  Schema.Struct({
    // Only an error object marks a JSON-RPC failure; any other error value is ignored.
    error: orFallback(
      Schema.UndefinedOr(Schema.Struct({ message: orFallback(Schema.String, "") })),
      undefined,
    ),
    result: orFallback(
      Schema.UndefinedOr(
        Schema.Struct({
          isError: orFallback(Schema.Boolean, false),
          content: orFallback(lenientArray(TextContent), []),
          structuredContent: Schema.optionalKey(Schema.Unknown),
        }),
      ),
      undefined,
    ),
  }),
);

/** Longest provider error excerpt carried into a user-facing message. */
const MAX_TOOL_ERROR_DETAIL = 200;

/**
 * Extract text content and structured content from a JSON-RPC tools/call response.
 *
 * @param payload - The parsed JSON-RPC message.
 * @param secrets - Secrets scrubbed from any provider error text.
 * @returns The tool result, or a ProviderToolError carrying a safe excerpt of the provider's text.
 */
export function parseMcpToolResult(
  payload: unknown,
  secrets: readonly (string | undefined)[] = [],
): Result.Result<McpToolCallResult, ProviderError> {
  const parsed = decodeToolCallResponse(payload);
  if (Result.isFailure(parsed)) {
    return Result.fail(new ProviderProtocolInvalid({ reason: "Expected an object payload" }));
  }
  const { error, result } = parsed.success;
  if (error !== undefined) {
    return Result.fail(new ProviderToolError({ detail: toolErrorDetail(error.message, secrets) }));
  }
  if (result === undefined) {
    return Result.fail(new ProviderProtocolInvalid({ reason: "Missing result object" }));
  }
  const text = result.content.map((item) => item.text.trim()).filter((item) => item !== "");
  if (result.isError) {
    return Result.fail(new ProviderToolError({ detail: toolErrorDetail(text.join(" "), secrets) }));
  }
  return Result.succeed({ text, structuredContent: result.structuredContent });
}

// Collapse, scrub, then cut: scrubbing first means truncation can never leave half a secret.
function toolErrorDetail(text: string, secrets: readonly (string | undefined)[]): string {
  const scrubbed = redactSecrets(text.replaceAll(/\s+/gu, " ").trim(), secrets);
  return scrubbed.length <= MAX_TOOL_ERROR_DETAIL
    ? scrubbed
    : `${scrubbed.slice(0, MAX_TOOL_ERROR_DETAIL - 3).trimEnd()}...`;
}

// Data payloads of an SSE event stream; multi-line data joins with newlines.
function parseSseDataLines(input: string): string[] {
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
