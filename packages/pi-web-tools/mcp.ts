import { Effect, Result } from "effect";
import { z } from "zod";
import { sendProviderRequest, withProviderDeadline } from "./provider-http";
import {
  lenientArray,
  parseJsonBody,
  ProviderProtocolInvalid,
  ProviderStatusRejected,
  ProviderToolError,
} from "./provider-types";
import type { ProviderError } from "./provider-types";
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
      /** Secrets scrubbed from provider error text before it reaches an error message. */
      readonly secrets?: readonly (string | undefined)[];
    },
  ) {}

  /** Run a full MCP session for a single tool call; the session closes however the call ends. */
  callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Effect.Effect<McpToolCallResult, ProviderError> {
    const post = (payload: Readonly<Record<string, unknown>>, sessionId: string | null) =>
      this.post(payload, sessionId);
    const closeSession = (sessionId: string) => this.closeSession(sessionId);
    const secrets = this.options.secrets ?? [];
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
      return yield* Effect.fromResult(parseMcpToolResult(message, secrets));
    });

    return session.pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          sessionId === null || sessionId === "" ? Effect.void : closeSession(sessionId),
        ),
      ),
      withProviderDeadline(this.options.timeoutMs),
    );
  }

  private post(
    payload: Readonly<Record<string, unknown>>,
    sessionId: string | null,
  ): Effect.Effect<McpPostOutcome, ProviderError> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.options.headers,
    };
    if (sessionId !== null && sessionId !== "") {
      headers["mcp-session-id"] = sessionId;
    }
    const sent = sendProviderRequest(
      this.options.fetchImpl ?? fetch,
      this.endpoint,
      { method: "POST", headers, body: JSON.stringify(payload) },
      this.options.maxResponseBytes,
    );
    return Effect.gen(function* () {
      const { response, bodyText } = yield* sent;
      if (response.status < 200 || response.status >= 300) {
        return yield* new ProviderStatusRejected({ status: response.status });
      }
      return {
        sessionId: response.headers.get("mcp-session-id"),
        bodyText,
        contentType: response.headers.get("content-type") ?? "",
      };
    });
  }

  // Best-effort: servers expire sessions on their own, so a failed DELETE is ignored.
  private closeSession(sessionId: string): Effect.Effect<void> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const { endpoint } = this;
    const headers = { "mcp-session-id": sessionId, ...this.options.headers };
    return Effect.tryPromise(async () =>
      fetchImpl(endpoint, {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(CLOSE_SESSION_TIMEOUT_MS),
      }),
    ).pipe(Effect.ignore);
  }
}

// A JSON-RPC response carries result or error; requests and notifications carry neither.
const jsonRpcResponseSchema = z
  .looseObject({})
  .refine((message) => "result" in message || "error" in message);

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
    (event) => Result.isSuccess(event) && jsonRpcResponseSchema.safeParse(event.success).success,
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

// Only text content is extracted; images, resources, and blank text are dropped.
const textContentSchema = z
  .object({ type: z.literal("text"), text: z.string() })
  .transform((item) => item.text.trim() || undefined);

const toolCallResponseSchema = z.object({
  // Only an error object marks a JSON-RPC failure; any other error value is ignored.
  error: z
    .object({ message: z.string().catch("") })
    .optional()
    .catch(undefined),
  result: z
    .object({
      isError: z.boolean().catch(false),
      content: lenientArray(textContentSchema).catch([]),
      structuredContent: z.unknown().optional(),
    })
    .optional()
    .catch(undefined),
});

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
  const parsed = toolCallResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return Result.fail(new ProviderProtocolInvalid({ reason: "Expected an object payload" }));
  }
  const { error, result } = parsed.data;
  if (error !== undefined) {
    return Result.fail(new ProviderToolError({ detail: toolErrorDetail(error.message, secrets) }));
  }
  if (result === undefined) {
    return Result.fail(new ProviderProtocolInvalid({ reason: "Missing result object" }));
  }
  if (result.isError) {
    return Result.fail(
      new ProviderToolError({ detail: toolErrorDetail(result.content.join(" "), secrets) }),
    );
  }
  return Result.succeed({ text: result.content, structuredContent: result.structuredContent });
}

// Collapse, scrub, then cut: scrubbing first means truncation can never leave half a secret.
function toolErrorDetail(text: string, secrets: readonly (string | undefined)[]): string {
  const scrubbed = redactSecrets(text.replaceAll(/\s+/gu, " ").trim(), secrets);
  return scrubbed.length <= MAX_TOOL_ERROR_DETAIL
    ? scrubbed
    : `${scrubbed.slice(0, MAX_TOOL_ERROR_DETAIL - 3).trimEnd()}...`;
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
