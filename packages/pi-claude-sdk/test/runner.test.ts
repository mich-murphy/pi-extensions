import { once } from "node:events";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { assert, describe, expect, test } from "vitest";
import { buildAgentRequest } from "../agent-request";
import type { AgentRequest } from "../agent-request";
import { createAgentSdkStream } from "../bridge";
import type { BridgeEvent } from "../bridge";
import type { CacheDiagnostic } from "../cache-tracker";
import { createCacheDiagnosticTracker } from "../cache-tracker";
import { models } from "../models";
import { createClaudeAgentSdkRunner } from "../sdk/runner";
import type {
  ModelObservation,
  RunnerOptions,
  RunSdkQuery,
  UsageLimitObservation,
} from "../sdk/runner";
import {
  contextFixture,
  deliverToolUses,
  deliverToolUse,
  drain,
  installedHook,
  modelFixture,
  requestFixture,
  resultMessage,
  sdkContentRecords,
  sdkPromptFixture,
  sonnet,
  streamEvent,
  textBlock,
  textDelta,
  unsettled,
} from "./fixtures";
import type { ToolUse, MessageFixture } from "./fixtures";

type SdkQueryParameters = Parameters<RunSdkQuery>[0];

const DEFERRED = resultMessage({ stop_reason: "tool_deferred" });
const READ_PACKAGE = { name: "read", arguments: { path: "package.json" } };
const INVALID_CALL = { name: "pi_call", arguments: {} };

type FallbackEnding = "clean-result" | "clean-eof" | "rejection";
type QueryFailure = "start" | "iterate" | "protocol" | "missing-result";

async function* fallbackEnding(ending: FallbackEnding, params: SdkQueryParameters) {
  if (ending === "clean-result") {
    yield DEFERRED;
  }
  if (ending === "rejection") {
    params.options?.abortController?.signal.throwIfAborted();
  }
}

function failingQuery(failure: QueryFailure): RunSdkQuery {
  return () => {
    if (failure === "start") {
      throw new Error("private start error");
    }
    return (async function* () {
      if (failure === "iterate") {
        throw new Error("private iteration error");
      }
      if (failure === "protocol") {
        yield streamEvent({ type: "message_delta", usage: { input_tokens: "private usage" } });
      }
      if (failure === "missing-result") {
        yield { type: "system", private: "ignored" };
      }
    })();
  };
}

async function runTurn(
  runSdkQuery: RunSdkQuery,
  request: AgentRequest = requestFixture(),
  options: SimpleStreamOptions & RunnerOptions = {},
): Promise<BridgeEvent[]> {
  return drain(
    createClaudeAgentSdkRunner({ validationRecovery: "pi-tool-loop", ...options, runSdkQuery })(
      request,
      sonnet,
      options,
    ),
  );
}

function toolUses(toolInputs: readonly unknown[]): ToolUse[] {
  return toolInputs.map((input, index) => ({ id: `toolu_${index}`, input }));
}

function queryWith(toolInputs: readonly unknown[], ...messages: readonly unknown[]): RunSdkQuery {
  return async function* fakeQuery(params) {
    await deliverToolUses(installedHook(params), toolUses(toolInputs));
    yield* messages;
  };
}

function failureOf(events: readonly BridgeEvent[]) {
  expect(events).toHaveLength(1);
  const [event] = events;
  if (event?.type !== "failed") {
    throw new Error("test setup: expected one failed event");
  }
  return event.error;
}

async function capturedParameters(
  request: AgentRequest,
  model = sonnet,
  options: SimpleStreamOptions = {},
): Promise<SdkQueryParameters> {
  const captured: SdkQueryParameters[] = [];
  const runner = createClaudeAgentSdkRunner({
    sdkEnvironment: { PATH: "/bin" },
    runSdkQuery: (params) => {
      captured.push(params);
      return queryWith([])(params);
    },
  });
  await drain(runner(request, model, options));
  const [params] = captured;
  if (!params) {
    throw new Error("test setup: SDK query was not started");
  }
  return params;
}

async function selectorFor(model: Model<"claude-sdk">): Promise<string | undefined> {
  const { options } = await capturedParameters(requestFixture(), model);
  return options?.model;
}

async function effortFor(id: string, reasoning: SimpleStreamOptions["reasoning"]) {
  const entry = models.find((candidate) => candidate.id === id);
  const probe = modelFixture({ id, reasoning: entry?.reasoning ?? false });
  const stream = reasoning === undefined ? {} : { reasoning };
  const { options } = await capturedParameters(requestFixture(), probe, stream);
  return options && "effort" in options ? options.effort : "omitted";
}

async function runWithHistory(history: readonly MessageFixture[]): Promise<BridgeEvent[]> {
  return runTurn(
    async function* fakeQuery({ prompt }) {
      await drain(sdkPromptFixture(prompt));
      yield resultMessage();
    },
    buildAgentRequest(contextFixture({ systemPrompt: "s", messages: history, tools: [] })),
  );
}

async function observeModels(...messages: readonly unknown[]) {
  const observations: ModelObservation[] = [];
  const events = await runTurn(queryWith([], ...messages), requestFixture(), {
    modelObserver: (observation) => {
      observations.push(observation);
    },
  });
  return { events, observations };
}

async function runAllowing(
  toolName: string,
  allowed: string,
  ...messages: readonly unknown[]
): Promise<BridgeEvent[]> {
  return runTurn(
    queryWith([{ name: toolName, arguments: { path: "fixture" } }], ...messages),
    requestFixture({ toolNames: new Set([allowed]) }),
  );
}

async function diagnose(...messages: readonly unknown[]): Promise<CacheDiagnostic[]> {
  return diagnoseQuery(queryWith([], ...messages));
}

async function diagnoseQuery(runSdkQuery: RunSdkQuery): Promise<CacheDiagnostic[]> {
  const diagnostics: CacheDiagnostic[] = [];
  await runTurn(runSdkQuery, requestFixture({ cacheBreakpoints: [0] }), {
    cacheDiagnostics: Effect.runSync(
      createCacheDiagnosticTracker((diagnostic) => {
        diagnostics.push(diagnostic);
      }),
    ),
  });
  return diagnostics;
}

describe("SDK query parameters", () => {
  test("starts each Pi turn in a stateless, tool-less SDK session with the complete transcript", async () => {
    const request = requestFixture({
      promptBlocks: [textBlock("first turn"), textBlock("second turn")],
    });

    const { prompt, options } = await capturedParameters(request);

    const messages = await drain(sdkPromptFixture(prompt));
    expect(messages).toHaveLength(1);
    expect(sdkContentRecords(messages[0]).map((block) => block.text)).toStrictEqual([
      "first turn",
      "second turn",
    ]);
    expect(options).toMatchObject({
      persistSession: false,
      includePartialMessages: true,
      systemPrompt: request.systemPrompt,
      settingSources: [],
      tools: [],
      env: { PATH: "/bin" },
    });
    expect(options?.resume).toBeUndefined();
    expect(options?.sessionId).toBeUndefined();
    expect(options?.maxTurns).toBe(8);
    assert(options?.mcpServers !== undefined, "test setup: SDK query has no MCP servers");
    expect(Object.keys(options.mcpServers)).toStrictEqual(["pi"]);
  });

  test("routes each registered versioned model ID to its Claude Code moving alias", async () => {
    const selectors = await Promise.all(
      models.map(async (model) => selectorFor(modelFixture(model))),
    );

    expect(selectors).toStrictEqual(["sonnet", "opus", "fable", "haiku", "claude-haiku-4-5"]);
  });

  test("passes unknown model IDs through to the Agent SDK unchanged", async () => {
    const ids = ["best", "claude-mythos-5-1"];

    const selectors = await Promise.all(ids.map(async (id) => selectorFor(modelFixture({ id }))));

    expect(selectors).toStrictEqual(ids);
  });

  test("maps Pi reasoning levels to SDK effort, and omits effort for Haiku 4.5 and for unset reasoning", async () => {
    const levels = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
    const efforts = ["low", "low", "medium", "high", "xhigh", "max"];
    const reasoningModels = [
      "claude-5.5-sonnet",
      "claude-5.5-opus",
      "claude-5.1-fable",
      "claude-5.5-haiku",
    ];

    const observed = await Promise.all(
      reasoningModels.map(async (id) => [
        id,
        await Promise.all(levels.map(async (level) => effortFor(id, level))),
      ]),
    );

    expect(Object.fromEntries(observed)).toStrictEqual(
      Object.fromEntries(reasoningModels.map((id) => [id, efforts])),
    );
    await expect(effortFor("claude-5.5-sonnet", undefined)).resolves.toBe("omitted");
    await expect(
      Promise.all(levels.map(async (level) => effortFor("claude-4.5-haiku", level))),
    ).resolves.toStrictEqual(levels.map(() => "omitted"));
  });

  test.each([
    ["minimal", 1024],
    ["low", 2048],
    ["medium", 8192],
    ["high", 16_384],
    ["xhigh", 16_384],
    ["max", 16_384],
  ] as const)(
    "uses a manual thinking budget for Haiku 4.5 at %s",
    async (reasoning, budgetTokens) => {
      const model = modelFixture({ id: "claude-4.5-haiku", reasoning: true });
      const { options } = await capturedParameters(requestFixture(), model, { reasoning });

      expect(options?.thinking).toStrictEqual({ type: "enabled", budgetTokens });
      expect(options?.effort).toBeUndefined();
    },
  );

  test("explicitly disables Haiku 4.5 thinking when Pi reasoning is off", async () => {
    const model = modelFixture({ id: "claude-4.5-haiku", reasoning: true });
    const { options } = await capturedParameters(requestFixture(), model);

    expect(options?.thinking).toStrictEqual({ type: "disabled" });
    expect(options?.effort).toBeUndefined();
  });

  test.each(["claude-haiku-4-5", "claude-haiku-4-5-20251001"])(
    "recognizes the manual thinking selector %s for custom models",
    async (id) => {
      const { options } = await capturedParameters(
        requestFixture(),
        modelFixture({ id, reasoning: true }),
        { reasoning: "low" },
      );
      expect(options?.thinking).toStrictEqual({ type: "enabled", budgetTokens: 2048 });
      expect(options?.effort).toBeUndefined();
    },
  );

  test.each([
    [4096, 4096],
    [4096.9, 4096],
    [1, 1024],
    [-1, 1024],
    [128_000, 30_976],
    [Number.NaN, 2048],
    [Number.POSITIVE_INFINITY, 2048],
  ])("bounds the custom manual thinking budget %s", async (budget, expected) => {
    const { options } = await capturedParameters(
      requestFixture(),
      { ...modelFixture({ id: "claude-4.5-haiku", reasoning: true }), maxTokens: 32_000 },
      { reasoning: "low", thinkingBudgets: { low: budget } },
    );
    expect(options?.thinking).toStrictEqual({ type: "enabled", budgetTokens: expected });
    expect(options?.effort).toBeUndefined();
  });

  test("does not enable thinking or effort for a custom non-reasoning model", async () => {
    const { options } = await capturedParameters(
      requestFixture(),
      modelFixture({ id: "custom", reasoning: false }),
      { reasoning: "high" },
    );
    expect(options?.thinking).toBeUndefined();
    expect(options?.effort).toBeUndefined();
  });

  test("sends at most four provider cache breakpoints, the last on the newest entry", async () => {
    const request = buildAgentRequest(
      contextFixture({
        systemPrompt: "s",
        messages: Array.from({ length: 41 }, (_, index) => ({
          role: "user",
          content: `entry ${index}`,
        })),
        tools: [],
      }),
    );

    const { prompt } = await capturedParameters(request);

    const [message] = await drain(sdkPromptFixture(prompt));
    const marked = sdkContentRecords(message).filter((block) => block.cache_control !== undefined);
    expect(marked).toHaveLength(4);
    expect(marked.at(-1)?.text).toContain("entry 40");
  });
});

describe("turn streaming", () => {
  test("streams deltas and complete running usage, then the stop reason", async () => {
    const events = await runTurn(
      queryWith(
        [],
        streamEvent({
          type: "message_start",
          message: { usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 4 } },
        }),
        textDelta("Hello"),
        streamEvent({ type: "content_block_stop", index: 0 }),
        streamEvent({ type: "message_delta", usage: { input_tokens: null, output_tokens: 3 } }),
        resultMessage({ stop_reason: "max_tokens" }),
      ),
    );

    expect(events).toStrictEqual([
      { type: "usage", usage: { input: 12, output: 1, cacheRead: 4, cacheWrite: 0 } },
      { type: "text_delta", text: "Hello" },
      { type: "usage", usage: { input: 12, output: 3, cacheRead: 4, cacheWrite: 0 } },
      { type: "done", reason: "length" },
    ]);
  });

  test("clears per-call cache splits from cumulative diagnostics and Pi usage when terminal split is absent", async () => {
    const diagnostics: CacheDiagnostic[] = [];
    const run = createClaudeAgentSdkRunner({
      runSdkQuery: queryWith(
        [],
        streamEvent({
          type: "message_start",
          message: {
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 7,
              cache_creation: { ephemeral_1h_input_tokens: 7, ephemeral_5m_input_tokens: 0 },
            },
          },
        }),
        streamEvent({
          type: "message_start",
          message: {
            usage: {
              input_tokens: 20,
              cache_creation_input_tokens: 3,
              cache_creation: { ephemeral_1h_input_tokens: 3, ephemeral_5m_input_tokens: 0 },
            },
          },
        }),
        resultMessage({
          num_turns: 2,
          usage: { input_tokens: 30, cache_creation_input_tokens: 10 },
        }),
      ),
      cacheDiagnostics: Effect.runSync(
        createCacheDiagnosticTracker((record) => diagnostics.push(record)),
      ),
    });
    const events = await drain(
      createAgentSdkStream({
        model: sonnet,
        context: contextFixture({ messages: [] }),
        options: {},
        run,
      }),
    );
    const terminal = events.at(-1);
    assert(terminal?.type === "error");
    expect(terminal.error.usage).toMatchObject({ input: 30, cacheWrite: 10 });
    expect(terminal.error.usage).not.toHaveProperty("cacheWrite1h");
    expect(diagnostics.at(-1)).toMatchObject({
      type: "usage",
      cacheWrite: 10,
      query: { numTurns: 2 },
    });
    expect(diagnostics.at(-1)).not.toHaveProperty("cacheWrite1h");
    expect(diagnostics.at(-1)).not.toHaveProperty("cacheWrite5m");
  });

  test("reconciles authoritative terminal usage before completion without double-counting SDK rounds", async () => {
    const events = await runTurn(
      queryWith(
        [],
        streamEvent({ type: "message_start", message: { usage: { input_tokens: 10 } } }),
        streamEvent({ type: "message_delta", usage: { output_tokens: 2 } }),
        streamEvent({ type: "message_start", message: { usage: { input_tokens: 4 } } }),
        resultMessage({
          usage: {
            input_tokens: 14,
            output_tokens: 5,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 1,
          },
        }),
      ),
    );

    expect(events.at(-2)).toStrictEqual({
      type: "usage",
      usage: { input: 14, output: 5, cacheRead: 3, cacheWrite: 1 },
    });
    expect(events.at(-1)).toMatchObject({ type: "failed", error: { _tag: "SdkProtocolError" } });
  });

  test("does not repeat terminal usage that matches the last streamed totals", async () => {
    const finalUsage = { input_tokens: 8, output_tokens: 3 };
    const events = await runTurn(
      queryWith(
        [],
        streamEvent({ type: "message_delta", usage: finalUsage }),
        resultMessage({ usage: finalUsage }),
      ),
    );

    expect(events).toStrictEqual([
      { type: "usage", usage: { input: 8, output: 3, cacheRead: 0, cacheWrite: 0 } },
      { type: "done", reason: "stop" },
    ]);
  });

  test("keeps streamed usage when an older terminal result omits usage", async () => {
    const events = await runTurn(
      queryWith(
        [],
        streamEvent({ type: "message_delta", usage: { input_tokens: 7, output_tokens: 2 } }),
        resultMessage(),
      ),
    );

    expect(events).toStrictEqual([
      { type: "usage", usage: { input: 7, output: 2, cacheRead: 0, cacheWrite: 0 } },
      { type: "done", reason: "stop" },
    ]);
  });

  test("emits terminal usage before a terminal SDK failure", async () => {
    const events = await runTurn(
      queryWith(
        [],
        resultMessage({ is_error: true, usage: { input_tokens: 3, output_tokens: 1 } }),
      ),
    );

    expect(events[0]).toStrictEqual({
      type: "usage",
      usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    expect(events[1]?.type).toBe("failed");
  });

  test("ends the turn at the result without waiting for the SDK to close its stream", async () => {
    let closed = false;

    const events = await runTurn(async function* fakeQuery() {
      try {
        yield resultMessage();
        await unsettled();
      } finally {
        closed = true;
      }
    });

    expect(events).toStrictEqual([{ type: "done", reason: "stop" }]);
    expect(closed).toBe(true);
  });

  test("aborts the SDK query once the turn is over so no subprocess outlives it", async () => {
    let sdkSignal: AbortSignal | undefined;

    await runTurn(async function* fakeQuery(params) {
      sdkSignal = params.options?.abortController?.signal;
      yield resultMessage();
    });

    expect(sdkSignal?.aborted).toBe(true);
  });

  test("an unsupported image kept in transcript history does not throw on a later turn", async () => {
    const messages: MessageFixture[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "What format is this?" },
          { type: "image", data: "dW5zdXBwb3J0ZWQ=", mimeType: "image/bmp" },
        ],
      },
    ];

    await expect(runWithHistory(messages)).resolves.toStrictEqual([
      { type: "done", reason: "stop" },
    ]);
    await expect(
      runWithHistory([...messages, { role: "user", content: "Never mind, thanks" }]),
    ).resolves.toStrictEqual([{ type: "done", reason: "stop" }]);
  });
});

describe("model observation", () => {
  test("reports the first main-loop model and its limits from a completed turn", async () => {
    const usage = { input_tokens: 1, output_tokens: 1 };
    const { events, observations } = await observeModels(
      streamEvent({ type: "message_start", message: { model: "claude-sonnet-5-5", usage } }),
      { type: "assistant", message: { model: "claude-haiku-4-5-20251001", usage } },
      resultMessage({
        modelUsage: {
          "claude-haiku-4-5-20251001": {
            canonicalModel: "claude-haiku-4-5",
            contextWindow: 200_000,
            maxOutputTokens: 64_000,
          },
          "claude-sonnet-5-5": {
            canonicalModel: "claude-sonnet-5-5",
            contextWindow: 1_000_000,
            maxOutputTokens: 128_000,
          },
        },
      }),
    );

    expect(events.at(-1)).toStrictEqual({ type: "done", reason: "stop" });
    expect(observations).toStrictEqual([
      {
        selector: "sonnet",
        canonicalModel: "claude-sonnet-5-5",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
      },
    ]);
  });

  test("reports no observation when the turn named no model", async () => {
    const { events, observations } = await observeModels(resultMessage());

    expect(events).toStrictEqual([{ type: "done", reason: "stop" }]);
    expect(observations).toStrictEqual([]);
  });
});

async function observeUsageLimits(...messages: readonly unknown[]) {
  const observations: UsageLimitObservation[] = [];
  const events = await runTurn(queryWith([], ...messages), requestFixture(), {
    usageLimitObserver: (observation) => {
      observations.push(observation);
    },
  });
  return { events, observations };
}

function rateLimitEvent(info: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { type: "rate_limit_event", rate_limit_info: info, uuid: "u", session_id: "s" };
}

const usageLimitResult = resultMessage({ is_error: true, terminal_reason: "blocking_limit" });

async function* usageLimitEnding(
  ending: "eof" | "iterate" | "protocol" | "cancelled",
  controller: AbortController,
) {
  if (ending === "iterate") {
    throw new Error("private iteration failure");
  }
  if (ending === "protocol") {
    yield { type: "result" };
  }
  if (ending === "cancelled") {
    controller.abort();
  }
}

function throwUsageObserver(): void {
  throw new Error("private observer failure");
}

async function rejectUsageObserver(): Promise<void> {
  throw new Error("private observer rejection");
}

describe("usage limit observation", () => {
  test("reports the rejected window's reset time in milliseconds when the turn fails on it", async () => {
    const { events, observations } = await observeUsageLimits(
      rateLimitEvent({ status: "allowed_warning", resetsAt: 1_792_540_000 }),
      rateLimitEvent({ status: "rejected", resetsAt: 1_792_548_000, rateLimitType: "five_hour" }),
      usageLimitResult,
    );

    expect(failureOf(events)).toMatchObject({ _tag: "SdkResultError", category: "usage-limit" });
    expect(observations).toStrictEqual([{ resetsAt: 1_792_548_000_000 }]);
  });

  test("reports a reset carried by a rate-limit API error", async () => {
    const usage = { input_tokens: 0, output_tokens: 0 };
    const { observations } = await observeUsageLimits(
      rateLimitEvent({ status: "rejected", resetsAt: 1_792_548_000 }),
      { type: "assistant", message: { usage }, error: "rate_limit" },
      resultMessage({ is_error: true }),
    );

    expect(observations).toStrictEqual([{ resetsAt: 1_792_548_000_000 }]);
  });

  test.each([
    ["no rate-limit event", []],
    ["a rejection without a reset time", [rateLimitEvent({ status: "rejected" })]],
    ["only a warning", [rateLimitEvent({ status: "allowed_warning", resetsAt: 1_792_548_000 })]],
    ["a malformed event", [{ type: "rate_limit_event", rate_limit_info: "full" }]],
  ])("reports nothing for %s", async (_name, preamble) => {
    const { events, observations } = await observeUsageLimits(...preamble, usageLimitResult);

    expect(failureOf(events)).toMatchObject({ category: "usage-limit" });
    expect(observations).toStrictEqual([]);
  });

  test.each([
    ["another failure", [resultMessage({ is_error: true, terminal_reason: "prompt_too_long" })]],
    ["success", [resultMessage()]],
    [
      "authentication overriding a usage limit",
      [
        { type: "assistant", message: { usage: {} }, error: "authentication_failed" },
        usageLimitResult,
      ],
    ],
  ])("reports nothing for %s", async (_name, ending) => {
    const { observations } = await observeUsageLimits(
      rateLimitEvent({ status: "rejected", resetsAt: 1_792_548_000 }),
      ...ending,
    );

    expect(observations).toStrictEqual([]);
  });

  test.each([
    ["rapid-refill terminal", "rapid_refill_breaker", "unknown", true],
    ["billing API error", undefined, "billing_error", true],
    ["explicit usage limit over generic API error", "blocking_limit", "invalid_request", true],
    ["context limit over earlier rate limit", "prompt_too_long", "rate_limit", false],
    ["cancellation over earlier rate limit", "aborted_streaming", "rate_limit", false],
    ["authentication over explicit usage limit", "blocking_limit", "oauth_org_not_allowed", false],
    ["unclassified terminal", undefined, "unknown", false],
  ])("uses effective error classification: %s", async (_name, terminalReason, apiError, notify) => {
    const { observations } = await observeUsageLimits(
      rateLimitEvent({ status: "rejected", resetsAt: 1_792_548_000 }),
      { type: "assistant", message: { usage: {} }, error: apiError },
      resultMessage({ is_error: true, terminal_reason: terminalReason }),
    );
    expect(observations).toHaveLength(Number(notify));
    expect(observations.every(({ resetsAt }) => resetsAt === 1_792_548_000_000)).toBe(true);
  });

  test.each(["eof", "iterate", "protocol", "cancelled"] as const)(
    "does not notify when a rejected window is followed by %s instead of a usage-limit result",
    async (ending) => {
      const observations: UsageLimitObservation[] = [];
      const controller = new AbortController();
      const events = await runTurn(
        async function* () {
          yield rateLimitEvent({ status: "rejected", resetsAt: 1_792_548_000 });
          yield* usageLimitEnding(ending, controller);
        },
        requestFixture(),
        {
          signal: controller.signal,
          usageLimitObserver: (observation) => {
            observations.push(observation);
          },
        },
      );
      expect(events.filter((event) => event.type === "failed")).toHaveLength(1);
      expect(observations).toStrictEqual([]);
    },
  );

  test("uses the latest reported rejected reset", async () => {
    const { observations } = await observeUsageLimits(
      rateLimitEvent({ status: "rejected", resetsAt: 1_792_548_000 }),
      rateLimitEvent({ status: "rejected", resetsAt: 1_792_549_000 }),
      usageLimitResult,
    );

    expect(observations).toStrictEqual([{ resetsAt: 1_792_549_000_000 }]);
  });

  test.each([
    ["allowed", { status: "allowed", resetsAt: 1_792_550_000 }],
    ["warning", { status: "allowed_warning", resetsAt: 1_792_550_000 }],
    ["missing reset", { status: "rejected" }],
    ["invalid reset", { status: "rejected", resetsAt: Number.MAX_VALUE }],
    ["unknown status", { status: "future_status", resetsAt: 1_792_550_000 }],
    ["malformed update", {}],
  ])("clears stale reset metadata after %s", async (_name, info) => {
    const { observations } = await observeUsageLimits(
      rateLimitEvent({ status: "rejected", resetsAt: 1_792_548_000 }),
      rateLimitEvent(info),
      usageLimitResult,
    );
    expect(observations).toStrictEqual([]);
  });

  test.each([
    ["throws", throwUsageObserver],
    ["rejects", rejectUsageObserver],
  ] as const)(
    "isolates an observer that %s and still closes the query",
    async (_name, usageLimitObserver) => {
      let closed = false;
      let signal: AbortSignal | undefined;
      const events = await runTurn(
        (params) => {
          signal = params.options?.abortController?.signal;
          return (async function* () {
            try {
              yield rateLimitEvent({ status: "rejected", resetsAt: 1_792_548_000 });
              yield usageLimitResult;
              throw new Error("must not read after result");
            } finally {
              closed = true;
            }
          })();
        },
        requestFixture(),
        {
          usageLimitObserver,
        },
      );
      expect(failureOf(events)).toMatchObject({ _tag: "SdkResultError", category: "usage-limit" });
      expect(events.filter((event) => event.type === "failed")).toHaveLength(1);
      expect(closed).toBe(true);
      expect(signal?.aborted).toBe(true);
    },
  );

  test("notifies before yielding the failure and does not retain reset times across queries", async () => {
    const order: string[] = [];
    const queries = [
      [rateLimitEvent({ status: "rejected", resetsAt: 1_792_548_000 }), usageLimitResult],
      [usageLimitResult],
    ];
    const runner = createClaudeAgentSdkRunner({
      async *runSdkQuery() {
        const messages = queries.shift();
        assert(messages);
        yield* messages;
      },
      usageLimitObserver: () => {
        order.push("notice");
      },
    });
    for (let turn = 0; turn < 2; turn += 1) {
      for await (const event of runner(requestFixture(), sonnet)) {
        order.push(event.type);
      }
    }

    expect(order).toStrictEqual(["notice", "failed", "failed"]);
  });
});

describe("deferred tool calls", () => {
  test.each(["clean-result", "clean-eof", "rejection"] as const)(
    "fails closed and aborts if the SDK executes the MCP fallback (%s)",
    async (ending) => {
      let fallback: (() => Promise<unknown>) | undefined;
      const createMcpServer: typeof createSdkMcpServer = (options) => {
        const server = createSdkMcpServer(options);
        const register = server.instance.registerTool.bind(server.instance);
        server.instance.registerTool = (name, config, handler) => {
          fallback = async () =>
            handler(
              { path: "package.json" },
              {
                signal: new AbortController().signal,
                requestId: "fixture",
                sendNotification: async () => undefined,
                sendRequest: async () => {
                  throw new Error("unused");
                },
              },
            );
          return register(name, config, handler);
        };
        return server;
      };
      const records: CacheDiagnostic[] = [];
      {
        const events = await runTurn(
          async function* fakeQuery(params) {
            await deliverToolUses(installedHook(params), toolUses([READ_PACKAGE]));
            assert(fallback !== undefined);
            await fallback();
            expect(params.options?.abortController?.signal.aborted).toBe(true);
            yield* fallbackEnding(ending, params);
          },
          requestFixture(),
          {
            createMcpServer,
            cacheDiagnostics: Effect.runSync(
              createCacheDiagnosticTracker((record) => records.push(record)),
            ),
          },
        );
        expect(failureOf(events)).toMatchObject({
          _tag: "SdkResultError",
          terminalReason: "tool_deferred_unavailable",
          category: "tool-contract",
        });
        expect(records.at(-1)).toMatchObject({
          type: "query",
          query: { outcome: "failed", fallbackCalls: 1 },
        });
      }
    },
  );

  test("keeps fallback contract failure ahead of pending correction calls", async () => {
    let fallback: (() => Promise<unknown>) | undefined;
    const events = await runTurn(
      async function* (params) {
        await deliverToolUses(
          installedHook(params),
          toolUses([INVALID_CALL, INVALID_CALL, INVALID_CALL, INVALID_CALL]),
        );
        assert(fallback !== undefined);
        await fallback();
        yield DEFERRED;
      },
      requestFixture(),
      {
        createMcpServer: (options) => {
          const server = createSdkMcpServer(options);
          const register = server.instance.registerTool.bind(server.instance);
          server.instance.registerTool = (name, config, handler) => {
            fallback = async () =>
              handler(
                { path: "package.json" },
                {
                  signal: new AbortController().signal,
                  requestId: "fixture",
                  sendNotification: async () => undefined,
                  sendRequest: async () => {
                    throw new Error("unused");
                  },
                },
              );
            return register(name, config, handler);
          };
          return server;
        },
      },
    );
    expect(failureOf(events)._tag).toBe("SdkResultError");
  });

  test("reports the SDK safety cap as a turn-limit failure without releasing captured calls", async () => {
    const error = failureOf(
      await runTurn(
        queryWith(
          [READ_PACKAGE],
          resultMessage({ is_error: true, terminal_reason: "max_turns", num_turns: 8 }),
        ),
      ),
    );

    expect(error).toMatchObject({
      _tag: "SdkResultError",
      terminalReason: "max_turns",
      category: "turn-limit",
    });
  });

  test("yields every hook-captured tool call once the SDK result confirms a clean defer", async () => {
    const second = { name: "read", arguments: { path: "README.md" } };

    const events = await runTurn(queryWith([READ_PACKAGE, second], DEFERRED));

    expect(events).toStrictEqual([
      {
        type: "tool_calls",
        calls: [
          { id: "toolu_0", ...READ_PACKAGE },
          { id: "toolu_1", ...second },
        ],
      },
    ]);
  });

  test("keeps each turn's declared catalog independent", async () => {
    await expect(runAllowing("read", "read", DEFERRED)).resolves.toStrictEqual([
      {
        type: "tool_calls",
        calls: [{ id: "toolu_0", name: "read", arguments: { path: "fixture" } }],
      },
    ]);
    await expect(runAllowing("write", "write", DEFERRED)).resolves.toStrictEqual([
      {
        type: "tool_calls",
        calls: [{ id: "toolu_0", name: "write", arguments: { path: "fixture" } }],
      },
    ]);
    const invalid = await runAllowing("read", "write", DEFERRED);
    expect(invalid).toMatchObject([
      { type: "tool_calls", calls: [{ name: "pi_claude_sdk_validation_error" }] },
    ]);
  });

  test("preserves invalid and valid siblings as separate Pi calls without SDK retries", async () => {
    const events = await runTurn(queryWith([INVALID_CALL, READ_PACKAGE], DEFERRED));
    expect(events).toMatchObject([
      {
        type: "tool_calls",
        calls: [
          {
            id: "toolu_0",
            name: "pi_claude_sdk_validation_error",
            arguments: { error: "unexpected_sdk_tool" },
          },
          { id: "toolu_1", ...READ_PACKAGE },
        ],
      },
    ]);
  });

  test("does not release correction calls from a rejected SDK query", async () => {
    const events = await runTurn(async function* (params) {
      await deliverToolUse(installedHook(params), { id: "bad", input: INVALID_CALL });
      yield { type: "system" };
      throw new Error("private failure");
    });
    expect(failureOf(events)._tag).toBe("SdkQueryError");
  });

  test("rejects tool_deferred when the hook captured no Pi call", async () => {
    const error = failureOf(await runTurn(queryWith([], DEFERRED)));

    expect(error._tag).toBe("SdkProtocolError");
    expect(error.message).toContain("tool handoff terminal result captured no calls");
  });

  test("rejects a captured Pi call unless the result confirms tool_deferred", async () => {
    const unconfirmed = resultMessage();
    const confirmedOther = resultMessage({ terminal_reason: "completed" });

    const missing = failureOf(await runTurn(queryWith([READ_PACKAGE], unconfirmed)));
    const completed = failureOf(await runTurn(queryWith([READ_PACKAGE], confirmedOther)));

    expect(missing._tag).toBe("SdkProtocolError");
    expect(missing.message).toContain("terminal_reason was missing");
    expect(completed.message).toContain("terminal_reason was completed");
  });
});

describe("turn failures", () => {
  test("returns an SDK result error even after the hook captured a deferred call", async () => {
    const unavailable = resultMessage({
      is_error: true,
      stop_reason: null,
      terminal_reason: "tool_deferred_unavailable",
      errors: ["the SDK could not honor the deferred tool call"],
    });

    const error = failureOf(await runTurn(queryWith([READ_PACKAGE], unavailable)));

    expect(error._tag).toBe("SdkResultError");
    expect(error.message).toBe("could not hand the requested Pi tool call back to Pi");
  });

  test("does not execute a captured tool call when SDK iteration fails", async () => {
    const events = await runTurn(async function* fakeQuery(params) {
      yield* queryWith([READ_PACKAGE])(params);
      throw new Error("transport disconnected");
    });

    const error = failureOf(events);

    expect(error).toMatchObject({
      _tag: "SdkQueryError",
      operation: "iterate",
      reason: { _tag: "Unclassified" },
    });
    expect(error.message).not.toContain("transport disconnected");
  });

  test("classifies an SDK stream that cannot be opened as an iteration failure", async () => {
    const unopenable: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: () => {
        throw new Error("stream unavailable");
      },
    };

    const error = failureOf(await runTurn(() => unopenable));

    expect(error).toMatchObject({
      _tag: "SdkQueryError",
      operation: "iterate",
      reason: { _tag: "Unclassified" },
    });
  });

  test("reports a typed authentication failure from an assistant message", async () => {
    const assistant = {
      type: "assistant",
      message: { model: "claude-sonnet", usage: { input_tokens: 1, output_tokens: 0 } },
      error: "authentication_failed",
    };
    const failedResult = resultMessage({
      is_error: true,
      stop_reason: null,
      result: "Invalid API key · Please run /login",
    });

    const events = await runTurn(queryWith([], assistant, failedResult));
    const error = events.at(-1);

    assert(error?.type === "failed");
    expect(error.error).toMatchObject({
      _tag: "SdkResultError",
      apiError: "authentication_failed",
    });
    expect(error.error.message).toBe("Claude Code authentication failed; run `claude` to sign in");
  });

  test.each([
    ["rate_limit", "authentication_failed"],
    ["authentication_failed", "rate_limit"],
    ["cloud_credential_error", "server_error"],
  ])("keeps authentication ahead of transient errors %s then %s", async (first, second) => {
    const events = await runTurn(
      queryWith(
        [],
        ...[first, second].map((error) => ({
          type: "assistant",
          message: { usage: {} },
          error,
        })),
        resultMessage({ is_error: true }),
      ),
    );
    const terminal = events.at(-1);
    assert(terminal?.type === "failed");
    expect(terminal.error.message).toContain("authentication failed");
  });

  test("reports a query that cannot start", async () => {
    const error = failureOf(
      await runTurn(() => {
        throw new Error("claude executable not found");
      }),
    );

    expect(error).toMatchObject({
      _tag: "SdkQueryError",
      operation: "start",
      reason: { _tag: "Unclassified" },
    });
  });

  test("fails on a malformed SDK message and stops the query", async () => {
    let closed = false;

    const events = await runTurn(async function* fakeQuery() {
      try {
        yield streamEvent({ type: "message_delta", usage: { output_tokens: "two" } });
        yield resultMessage();
      } finally {
        closed = true;
      }
    });

    expect(failureOf(events)._tag).toBe("SdkProtocolError");
    expect(closed).toBe(true);
  });

  test("fails when SDK iteration ends without a terminal result", async () => {
    const runSdkQuery = queryWith([], textDelta("Truncated"));

    const events = await runTurn(runSdkQuery);

    expect(events[0]).toStrictEqual({ type: "text_delta", text: "Truncated" });
    expect(failureOf(events.slice(1))._tag).toBe("SdkMissingResultError");
  });
});

describe("SDK query cancellation", () => {
  test("does not start an SDK query for an already-aborted signal", async () => {
    let queryStarted = false;
    const controller = new AbortController();
    controller.abort("cancelled before start");

    const events = await runTurn(
      (params) => {
        queryStarted = true;
        return queryWith([])(params);
      },
      requestFixture(),
      { signal: controller.signal },
    );

    expect(queryStarted).toBe(false);
    expect(failureOf(events)).toMatchObject({
      _tag: "SdkQueryError",
      operation: "start",
      reason: { _tag: "Cancelled" },
    });
  });

  test("reports caller cancellation when the SDK returns a clean result after being aborted", async () => {
    const controller = new AbortController();
    const events = await runTurn(
      async function* fakeQuery() {
        controller.abort("cancelled before terminal result");
        yield resultMessage();
      },
      requestFixture(),
      { signal: controller.signal },
    );

    expect(failureOf(events)).toMatchObject({
      _tag: "SdkQueryError",
      operation: "iterate",
      reason: { _tag: "Cancelled" },
    });
  });

  test("reports cancellation, not a missing result, on clean aborted EOF", async () => {
    const controller = new AbortController();
    const events = await runTurn(
      async function* fakeQuery() {
        controller.abort("private reason");
        yield textDelta("partial");
      },
      requestFixture(),
      { signal: controller.signal },
    );
    expect(failureOf(events.slice(1))).toMatchObject({
      _tag: "SdkQueryError",
      operation: "iterate",
      reason: { _tag: "Cancelled" },
    });
  });

  test("keeps an explicit failed terminal result ahead of caller cancellation", async () => {
    const controller = new AbortController();
    const events = await runTurn(
      async function* fakeQuery() {
        controller.abort("private reason");
        yield resultMessage({ is_error: true, terminal_reason: "blocking_limit" });
      },
      requestFixture(),
      { signal: controller.signal },
    );
    expect(failureOf(events)).toMatchObject({ _tag: "SdkResultError", category: "usage-limit" });
  });

  test("keeps cancellation ahead of pending correction calls", async () => {
    const controller = new AbortController();
    const events = await runTurn(
      async function* fakeQuery(params) {
        await deliverToolUses(
          installedHook(params),
          toolUses([INVALID_CALL, INVALID_CALL, INVALID_CALL, INVALID_CALL]),
        );
        controller.abort("cancelled after invalid calls");
        yield resultMessage();
      },
      requestFixture(),
      { signal: controller.signal },
    );

    expect(failureOf(events)._tag).toBe("SdkQueryError");
  });

  test("forwards cancellation during iteration and ends Pi with one aborted event", async () => {
    let markTextYielded: (() => void) | undefined;
    const textYielded = new Promise<void>((resolve) => {
      markTextYielded = resolve;
    });
    let sdkSignal: AbortSignal | undefined;
    const run = createClaudeAgentSdkRunner({
      runSdkQuery: async function* runSdkQuery(params) {
        const signal = params.options?.abortController?.signal;
        assert(signal !== undefined, "test setup: SDK abort signal missing");
        sdkSignal = signal;
        yield textDelta("Partial");
        markTextYielded?.();
        await once(signal, "abort");
        signal.throwIfAborted();
      },
    });
    const controller = new AbortController();
    const context = contextFixture({
      systemPrompt: "Be concise.",
      messages: [{ role: "user", content: "Hello" }],
      tools: [],
    });
    const eventsPromise = drain(
      createAgentSdkStream({ model: sonnet, context, options: { signal: controller.signal }, run }),
    );
    await textYielded;
    const cancellationReason = new Error("cancelled by test");

    controller.abort(cancellationReason);
    const events = await eventsPromise;

    expect(sdkSignal?.reason).toBe(cancellationReason);
    expect(events.map((event) => event.type)).toStrictEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "error",
    ]);
    const terminal = events.at(-1);
    assert(terminal?.type === "error", "test setup: expected Pi error event");
    expect(terminal.reason).toBe("aborted");
    expect(terminal.error.content).toStrictEqual([{ type: "text", text: "Partial" }]);
  });
});

describe("cache diagnostics", () => {
  const usage = streamEvent({
    type: "message_delta",
    usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 95 },
  });

  test("records the request and the final usage of a completed turn", async () => {
    await expect(diagnose(usage, resultMessage())).resolves.toMatchObject([
      { type: "request", turn: 1, model: "claude-sdk/claude-5.5-sonnet", breakpoints: [0] },
      { type: "usage", turn: 1, input: 5, cacheRead: 95, cacheReadPercent: 95 },
    ]);
  });

  test("records internal round-trips, side-model totals and error results without any payloads", async () => {
    const diagnostics = await diagnoseQuery(async function* fakeQuery(params) {
      const hook = installedHook(params);
      await deliverToolUse(hook, { id: "private denied id", input: INVALID_CALL });
      await deliverToolUse(hook, {
        id: "private top id",
        toolName: "private tool",
        input: { secret: true },
      });
      yield streamEvent({
        type: "content_block_start",
        content_block: { type: "tool_use", name: "private tool" },
      });
      yield {
        type: "assistant",
        message: {
          usage: { input_tokens: 5 },
          content: [
            { type: "tool_use", name: "private name", input: { secret: true } },
            { type: "tool_use", name: "private name2", input: {} },
          ],
        },
        error: "rate_limit",
      };
      yield {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              is_error: true,
              content: "private error",
              tool_use_id: "private id",
            },
            { type: "tool_result", is_error: false, content: "private success" },
          ],
        },
        tool_use_result: { private: "output" },
      };
      yield {
        type: "assistant",
        message: {
          usage: { input_tokens: 8 },
          content: [{ type: "tool_use", input: { private: true } }],
        },
        error: "authentication_failed",
      };
      yield resultMessage({
        num_turns: 3,
        usage: { input_tokens: 20, cache_read_input_tokens: 100 },
        modelUsage: {
          sonnet: { inputTokens: 20, cacheReadInputTokens: 100, cacheCreationInputTokens: 0 },
          "private custom routing": {
            inputTokens: 7,
            cacheReadInputTokens: 8,
            cacheCreationInputTokens: 9,
          },
        },
      });
    });
    expect(diagnostics.at(-1)).toMatchObject({
      type: "usage",
      input: 20,
      cacheRead: 100,
      promptTokens: 120,
      query: {
        outcome: "failed",
        numTurns: 3,
        models: [
          { model: "sonnet", promptTokens: 120 },
          { model: "unknown-2", promptTokens: 24 },
        ],
        apiError: "authentication_failed",
        assistantToolUses: 3,
        maxAssistantToolUses: 2,
        errorToolResults: 1,
        hookDeniedCalls: 0,
        invalidGatewayCalls: 0,
        unexpectedToolCalls: 2,
        fallbackCalls: 0,
      },
    });
    expect(JSON.stringify(diagnostics)).not.toContain("private");
  });

  test.each(["start", "iterate", "protocol", "missing-result"] as const)(
    "records safe diagnostics even when failure at %s has no usage",
    async (failure) => {
      const diagnostics = await diagnoseQuery(failingQuery(failure));
      expect(diagnostics).toMatchObject([
        { type: "request" },
        { type: "query", query: { outcome: "failed" } },
      ]);
      expect(JSON.stringify(diagnostics)).not.toContain("private");
    },
  );

  test("records last reported partial usage when iteration fails without fabricating a terminal result", async () => {
    const diagnostics = await diagnoseQuery(async function* () {
      yield usage;
      throw new Error("private iteration error");
    });
    expect(diagnostics.at(-1)).toMatchObject({
      type: "usage",
      input: 5,
      cacheRead: 95,
      query: { outcome: "failed" },
    });
    expect(diagnostics.at(-1)).not.toHaveProperty("query.numTurns");
  });

  test("malformed optional query metadata cannot fail an otherwise valid turn", async () => {
    const diagnostics = await diagnose(
      resultMessage({
        num_turns: "private",
        modelUsage: {
          "private model": {
            inputTokens: -1,
            cacheReadInputTokens: "private count",
            cacheCreationInputTokens: null,
            canonicalModel: { private: true },
          },
        },
        usage: { input_tokens: 12 },
      }),
    );
    expect(diagnostics.at(-1)).toMatchObject({
      type: "usage",
      input: 12,
      query: {
        outcome: "completed",
        models: [{ model: "unknown-1" }],
      },
    });
    expect(diagnostics.at(-1)).not.toHaveProperty("query.numTurns");
    expect(JSON.stringify(diagnostics)).not.toContain("private");
  });

  test("records safe usage for failed terminals, preserving the authoritative cumulative total", async () => {
    const diagnostics = await diagnose(
      usage,
      resultMessage({
        is_error: true,
        num_turns: 3,
        usage: { input_tokens: 15, cache_read_input_tokens: 285, output_tokens: 6 },
        errors: ["private failure text"],
      }),
    );

    expect(diagnostics).toMatchObject([
      { type: "request" },
      {
        type: "usage",
        input: 15,
        cacheRead: 285,
        output: 6,
        promptTokens: 300,
        query: { outcome: "failed", numTurns: 3 },
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("private failure");
  });
});

describe("prompt cache settings", () => {
  test("names the session so the SDK skips its transcript-titling side request", async () => {
    const { options } = await capturedParameters(requestFixture());

    expect(options?.title).toMatch(/\S/u);
  });

  test.each([
    [{ cacheRetention: "none" }, undefined],
    [{ cacheRetention: "short" }, { type: "ephemeral" }],
    [{ cacheRetention: "long" }, { type: "ephemeral", ttl: "1h" }],
    [{}, { type: "ephemeral" }],
  ] as const)(
    "maps stream options %j to every breakpoint's cache_control",
    async (retention, expected) => {
      const request = requestFixture({
        promptBlocks: [textBlock("a"), textBlock("b")],
        cacheBreakpoints: [0, 1],
      });
      const { prompt } = await capturedParameters(request, sonnet, retention);

      const [message] = await drain(sdkPromptFixture(prompt));
      expect(sdkContentRecords(message).map((block) => block.cache_control)).toStrictEqual([
        expected,
        expected,
      ]);
    },
  );
});
