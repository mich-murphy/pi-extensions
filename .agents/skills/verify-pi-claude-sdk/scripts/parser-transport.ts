// OFFLINE synthetic Anthropic Messages transport. Real installed SDK/CLI parses
// these SSE frames. Never used by production or with subscription credentials.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Socket } from "node:net";

export const DUMMY_PARSER_KEY = "pi-offline-parser-dummy-key";

export async function startParserTransport() {
  let requests = 0;
  let unexpected = 0;
  let invalidJsonResponses = 0;
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    // Body is deliberately discarded, never decoded, retained or logged.
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1_048_576) {
        request.destroy();
      }
    });
    request.on("end", () => {
      if (
        request.method !== "POST" ||
        request.url?.split("?")[0] !== "/v1/messages" ||
        request.headers["x-api-key"] !== DUMMY_PARSER_KEY ||
        request.headers.authorization !== undefined ||
        requests >= 3
      ) {
        unexpected += 1;
        response.writeHead(400).end();
        return;
      }
      requests += 1;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const emit = (type: string, data: Record<string, unknown>) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      emit("message_start", {
        message: {
          id: `offline-parser-${requests}`,
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5-20251001",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });
      if (requests <= 2) {
        emit("content_block_start", {
          index: 0,
          content_block: {
            type: "tool_use",
            id: `offline-tool-${requests}`,
            name: "mcp__pi__pi_call",
            input: {},
          },
        });
        // A complete tool-use response with invalid JSON, NOT max_tokens or stream truncation.
        // The bundled CLI, not this fixture/harness, must generate its parse error and marker.
        const partial =
          requests === 1
            ? '{"name":"contract_probe","arguments":INVALID_JSON}'
            : JSON.stringify({ name: "contract_probe", arguments: { value: "corrected" } });
        if (requests === 1) {
          invalidJsonResponses += 1;
        }
        emit("content_block_delta", {
          index: 0,
          delta: { type: "input_json_delta", partial_json: partial },
        });
        emit("content_block_stop", { index: 0 });
        emit("message_delta", {
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 20 },
        });
      } else {
        emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        emit("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: "RECOVERY_OK" },
        });
        emit("content_block_stop", { index: 0 });
        emit("message_delta", {
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 3 },
        });
      }
      emit("message_stop", {});
      response.end();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address !== null && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    summary: () => ({ requests, unexpected, invalidJsonResponses }),
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
