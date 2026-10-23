import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { z } from "zod";
import { createAgentSdkStream } from "../bridge";
import type { AgentSdkRun } from "../bridge";
import { createCacheDiagnosticTracker } from "../cache-tracker";
import { createClaudeAgentSdkRunner } from "../sdk/runner";
import type { RunSdkQuery } from "../sdk/runner";
import {
  blockValidationRecovery,
  VALIDATION_ERROR_TOOL,
  validationRecoveryTool,
} from "../validation-recovery";
import { modelFixture } from "./fixtures";

export const offlineContractPath = fileURLToPath(import.meta.url);

const scenarioSchema = z.enum(["siblings", "schema", "malformed", "cancelled", "invalid-terminal"]);
type Scenario = z.infer<typeof scenarioSchema>;
type Proof = {
  readonly scenario: Scenario;
  readonly session: SessionManager;
  readonly controller: AbortController;
  readonly executions: string[];
  readonly terminals: number[];
  readonly released: string[][];
  requests: number;
  queries: number;
  preHooks: number;
  batches: number;
  fallbackCalls: number;
  reservedExecutions: number;
  durableBeforeCorrection: boolean;
};
type Emit = (type: string, data: Record<string, unknown>) => void;

function isMessage(message: AgentMessage): message is Message {
  return ["system", "user", "assistant", "toolResult"].includes(message.role);
}

function persisted(session: SessionManager): Message[] {
  const file = session.getSessionFile();
  assert(file !== undefined);
  return SessionManager.open(file)
    .getEntries()
    .flatMap((entry) =>
      entry.type === "message" && isMessage(entry.message) ? [entry.message] : [],
    );
}

function recovering(scenario: Scenario): boolean {
  return scenario === "schema" || scenario === "malformed";
}

function assertAdvertised(chunks: readonly Buffer[]): void {
  const payload = z
    .object({
      tools: z.array(
        z
          .object({
            name: z.string(),
            input_schema: z
              .object({
                type: z.literal("object"),
                properties: z.record(z.string(), z.unknown()),
                required: z.array(z.string()).optional(),
              })
              .loose(),
            defer_loading: z.boolean().optional(),
          })
          .loose(),
      ),
    })
    .loose()
    .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const advertised = payload.tools.find((tool) => tool.name === "mcp__pi__probe");
  assert(advertised !== undefined);
  assert.deepEqual(advertised.input_schema.properties.value, { type: "string" });
  assert.deepEqual(advertised.input_schema.required, ["value"]);
  assert.notEqual(advertised.defer_loading, true);
}

function fixtureInput(scenario: Scenario, request: number, index: number): string {
  if (request === 1 && scenario === "malformed") {
    return '{"value":INVALID_JSON}';
  }
  if (request === 1 && scenario === "schema") {
    return "{}";
  }
  return JSON.stringify({ value: recovering(scenario) ? "corrected" : `sibling-${index}` });
}

function emitCalls(emit: Emit, proof: Proof): void {
  const count = proof.scenario === "siblings" ? 2 : 1;
  for (let index = 0; index < count; index += 1) {
    emit("content_block_start", {
      index,
      content_block: {
        type: "tool_use",
        id: `call-${proof.requests}-${index}`,
        name: "mcp__pi__probe",
        input: {},
      },
    });
    emit("content_block_delta", {
      index,
      delta: {
        type: "input_json_delta",
        partial_json: fixtureInput(proof.scenario, proof.requests, index),
      },
    });
    emit("content_block_stop", { index });
  }
}

function emitResponse(emit: Emit, proof: Proof): void {
  emit("message_start", {
    message: {
      id: `offline-${proof.requests}`,
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5-20251001",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 0 },
    },
  });
  const callTurn = proof.requests === 1 || (recovering(proof.scenario) && proof.requests === 2);
  if (callTurn) {
    emitCalls(emit, proof);
  } else {
    emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: "OFFLINE_OK" } });
    emit("content_block_stop", { index: 0 });
  }
  let stopReason = callTurn ? "tool_use" : "end_turn";
  if (proof.scenario === "invalid-terminal") {
    stopReason = "max_tokens";
  }
  emit("message_delta", {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 20 },
  });
  emit("message_stop", {});
}

async function startTransport(proof: Proof) {
  const server = createServer((request, response) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      chunks.push(chunk);
      if (bytes > 1_048_576) {
        request.destroy();
      }
    });
    request.on("end", () => {
      if (
        request.method !== "POST" ||
        request.url?.split("?")[0] !== "/v1/messages" ||
        request.headers["x-api-key"] !== "pi-offline-dummy" ||
        request.headers.authorization !== undefined ||
        proof.requests >= 3
      ) {
        response.writeHead(400).end();
        return;
      }
      assertAdvertised(chunks);
      proof.requests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      emitResponse((type, data) => {
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      }, proof);
      response.end();
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address !== null && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
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

function observeHooks(params: Parameters<RunSdkQuery>[0], proof: Proof) {
  const pre = params.options?.hooks?.PreToolUse?.[0]?.hooks?.[0];
  const batch = params.options?.hooks?.PostToolBatch?.[0]?.hooks?.[0];
  assert(pre && batch);
  return {
    PreToolUse: [
      {
        hooks: [
          async (...args: Parameters<typeof pre>) => {
            proof.preHooks += 1;
            return pre(...args);
          },
        ],
      },
    ],
    PostToolBatch: [
      {
        hooks: [
          async (...args: Parameters<typeof batch>) => {
            proof.batches += 1;
            return batch(...args);
          },
        ],
      },
    ],
  };
}

function terminalFixture(message: SDKMessage, proof: Proof): unknown {
  if (message.type !== "result") {
    return message;
  }
  if (proof.scenario === "cancelled") {
    proof.controller.abort();
  }
  if (proof.scenario === "invalid-terminal") {
    return { ...message, stop_reason: "max_tokens", terminal_reason: "completed" };
  }
  return message;
}

function observedQuery(proof: Proof): RunSdkQuery {
  return async function* (params) {
    proof.queries += 1;
    assert(proof.queries <= 3);
    if (recovering(proof.scenario) && proof.queries === 2) {
      proof.durableBeforeCorrection = persisted(proof.session).some(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === VALIDATION_ERROR_TOOL &&
          message.isError,
      );
      assert(proof.durableBeforeCorrection);
      assert.equal(proof.executions.length, 0);
    }
    for await (const message of query({
      ...params,
      options: { ...params.options, hooks: observeHooks(params, proof) },
    })) {
      yield terminalFixture(message, proof);
    }
  };
}

function toolsFor(proof: Proof): AgentTool[] {
  return [
    {
      name: "probe",
      label: "Pure probe",
      description: "Pure contract fixture",
      parameters: Type.Object({ value: Type.String() }),
      async execute(_id, input) {
        proof.executions.push(z.object({ value: z.string() }).parse(input).value);
        return { content: [{ type: "text", text: "OFFLINE_OK" }], details: undefined };
      },
    },
    {
      ...validationRecoveryTool,
      async execute() {
        proof.reservedExecutions += 1;
        throw new Error("reserved executor must never run");
      },
    },
  ];
}

function observedStream(proof: Proof, run: AgentSdkRun): StreamFn {
  return (model, context, options) => {
    const index = proof.terminals.length;
    proof.terminals.push(0);
    proof.released.push([]);
    const stream = createAgentSdkStream({ model, context, options, run });
    const iterator = stream[Symbol.asyncIterator].bind(stream);
    stream[Symbol.asyncIterator] = async function* () {
      for await (const event of { [Symbol.asyncIterator]: iterator }) {
        if (event.type === "done" || event.type === "error") {
          proof.terminals[index] = (proof.terminals[index] ?? 0) + 1;
          const message = event.type === "done" ? event.message : event.error;
          proof.released[index] = message.content.flatMap((content) =>
            content.type === "toolCall" ? [content.name] : [],
          );
        }
        yield event;
      }
    };
    return stream;
  };
}

function assertRecovery(proof: Proof): void {
  assert.deepEqual(proof.executions, ["corrected"]);
  assert(proof.durableBeforeCorrection);
  assert.deepEqual(proof.released[0], [VALIDATION_ERROR_TOOL]);
  const firstError = persisted(proof.session).find(
    (message) =>
      message.role === "assistant" &&
      message.content.some(
        (content) => content.type === "toolCall" && content.name === VALIDATION_ERROR_TOOL,
      ),
  );
  assert(firstError?.role === "assistant");
  const call = firstError.content.find((content) => content.type === "toolCall");
  assert(call?.type === "toolCall");
  assert.equal(
    call.arguments.error,
    proof.scenario === "malformed" ? "sdk_input_rejected" : "invalid_tool_input",
  );
  assert.equal(proof.requests, 3);
}

function assertProof(proof: Proof): void {
  assert(proof.terminals.length > 0 && proof.terminals.every((count) => count === 1));
  assert.equal(proof.fallbackCalls, 0);
  assert.equal(proof.reservedExecutions, 0);
  if (proof.scenario === "siblings") {
    assert.deepEqual(proof.executions.toSorted(), ["sibling-0", "sibling-1"]);
    assert.equal(proof.preHooks, 2);
    assert.deepEqual(proof.released[0], ["probe", "probe"]);
    assert.equal(proof.requests, 2);
  } else if (recovering(proof.scenario)) {
    assertRecovery(proof);
  } else {
    assert.deepEqual(proof.executions, []);
    assert.deepEqual(proof.released[0], []);
    assert.equal(proof.requests, 1);
  }
}

function persistEvent(session: SessionManager, event: AgentEvent): void {
  if (event.type === "message_end" && isMessage(event.message)) {
    session.appendMessage(event.message);
  }
}

async function runContract(): Promise<void> {
  const home = z.string().includes("pi-sdk-contract-").parse(process.env.HOME);
  const proof: Proof = {
    scenario: scenarioSchema.parse(process.env.PI_SDK_OFFLINE_CASE),
    session: SessionManager.create(home, home),
    controller: new AbortController(),
    executions: [],
    terminals: [],
    released: [],
    requests: 0,
    queries: 0,
    preHooks: 0,
    batches: 0,
    fallbackCalls: 0,
    reservedExecutions: 0,
    durableBeforeCorrection: false,
  };
  const transport = await startTransport(proof);
  const run = createClaudeAgentSdkRunner({
    validationRecovery: "pi-tool-loop",
    runSdkQuery: observedQuery(proof),
    cacheDiagnostics: Effect.runSync(
      createCacheDiagnosticTracker((record) => {
        if (record.type === "query" || record.type === "usage") {
          proof.fallbackCalls += record.query?.fallbackCalls ?? 0;
        }
      }),
    ),
    sdkEnvironment: {
      ...process.env,
      ANTHROPIC_BASE_URL: transport.baseUrl,
      ANTHROPIC_API_KEY: "pi-offline-dummy",
      ANTHROPIC_AUTH_TOKEN: undefined,
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "2048",
      DISABLE_PROMPT_CACHING: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  });
  const timer = setTimeout(() => {
    proof.controller.abort();
  }, 30_000);
  try {
    await runAgentLoop(
      [{ role: "user", content: "Offline fixture", timestamp: 0 }],
      { messages: [], tools: toolsFor(proof) },
      {
        model: modelFixture({ id: "claude-4.5-haiku", reasoning: false }),
        convertToLlm: (messages) => messages.filter((message) => isMessage(message)),
        beforeToolCall: async ({ toolCall, args }) => blockValidationRecovery(toolCall.name, args),
      },
      (event) => {
        persistEvent(proof.session, event);
      },
      proof.controller.signal,
      observedStream(proof, run),
    );
    assertProof(proof);
    process.stdout.write(
      JSON.stringify({
        scenario: proof.scenario,
        requests: proof.requests,
        queries: proof.queries,
        preHooks: proof.preHooks,
        batches: proof.batches,
        terminals: proof.terminals,
        executions: proof.executions.length,
        durableBeforeCorrection: proof.durableBeforeCorrection,
        fallbackCalls: proof.fallbackCalls,
      }),
    );
  } finally {
    clearTimeout(timer);
    proof.controller.abort();
    await transport.close();
  }
}

if (process.env.PI_SDK_OFFLINE_CHILD === "1") {
  await runContract();
}
