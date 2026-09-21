import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { type AgentRequest, buildAgentRequest } from "../agent-request";
import { type BridgeEvent, createAgentSdkStream } from "../bridge";
import type { CacheDiagnostic } from "../cache-tracker";
import { createCacheDiagnosticTracker } from "../cache-tracker";
import { models } from "../models";
import {
  createClaudeAgentSdkRunner,
  type ModelObservation,
  type RunnerOptions,
  type RunSdkQuery,
} from "../sdk/runner";
import {
  contextFixture,
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
} from "./fixtures";

type SdkQueryParameters = Parameters<RunSdkQuery>[0];

const DEFERRED = resultMessage({ stop_reason: "tool_deferred" });
const READ_PACKAGE = { name: "read", arguments: { path: "package.json" } };
const INVALID_CALL = { name: "pi_call", arguments: {} };

function runTurn(
  runSdkQuery: RunSdkQuery,
  request: AgentRequest = requestFixture(),
  options: SimpleStreamOptions & RunnerOptions = {},
): Promise<BridgeEvent[]> {
  return drain(createClaudeAgentSdkRunner({ ...options, runSdkQuery })(request, sonnet, options));
}

// A fake SDK query that delivers gateway requests to the installed hook, then yields messages.
function queryWith(
  toolInputs: ReadonlyArray<unknown>,
  ...messages: ReadonlyArray<unknown>
): RunSdkQuery {
  return async function* (params) {
    for (const [index, toolInput] of toolInputs.entries()) {
      await deliverToolUse(installedHook(params), `toolu_${index}`, toolInput);
    }
    yield* messages;
  };
}

function failureOf(events: ReadonlyArray<BridgeEvent>) {
  expect(events).toHaveLength(1);
  const [event] = events;
  if (event?.type !== "failed") throw new Error("test setup: expected one failed event");
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
      return (async function* () {})();
    },
  });
  await drain(runner(request, model, options));
  const [params] = captured;
  if (!params) throw new Error("test setup: SDK query was not started");
  return params;
}

describe("SDK query parameters", () => {
  test("starts each Pi turn in a stateless, tool-less SDK session with the complete transcript", async () => {
    const request = requestFixture({
      promptBlocks: [textBlock("first turn"), textBlock("second turn")],
    });

    const { prompt, options } = await capturedParameters(request);

    const messages = await drain(sdkPromptFixture(prompt));
    expect(messages).toHaveLength(1);
    expect(sdkContentRecords(messages[0]).map((block) => block.text)).toEqual([
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
    expect(options?.maxTurns).toBeUndefined();
    expect(Object.keys(options?.mcpServers ?? {})).toEqual(["pi"]);
  });

  test("routes each registered versioned model ID to its Claude Code moving alias", async () => {
    const selectors: unknown[] = [];
    for (const model of models) {
      const probe = modelFixture({ ...model, api: "claude-sdk", provider: "claude-sdk" });
      selectors.push((await capturedParameters(requestFixture(), probe)).options?.model);
    }

    expect(selectors).toEqual(["sonnet", "opus", "fable", "haiku"]);
  });

  test("passes unknown model IDs through to the Agent SDK unchanged", async () => {
    for (const id of ["best", "claude-mythos-5-1"]) {
      const probe = modelFixture({ api: "claude-sdk", provider: "claude-sdk", id });
      expect((await capturedParameters(requestFixture(), probe)).options?.model).toBe(id);
    }
  });

  test("maps Pi reasoning levels to SDK effort, and omits effort for Haiku and for unset reasoning", async () => {
    const effortFor = async (id: string, reasoning: SimpleStreamOptions["reasoning"]) => {
      const entry = models.find((candidate) => candidate.id === id);
      const probe = modelFixture({ ...entry, api: "claude-sdk", provider: "claude-sdk" });
      const stream = reasoning === undefined ? {} : { reasoning };
      const { options } = await capturedParameters(requestFixture(), probe, stream);
      return options && "effort" in options ? options.effort : "omitted";
    };
    const levels = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

    expect(await Promise.all(levels.map((level) => effortFor("claude-5-sonnet", level)))).toEqual([
      "low",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(await effortFor("claude-5-sonnet", undefined)).toBe("omitted");
    for (const level of levels) expect(await effortFor("claude-4.5-haiku", level)).toBe("omitted");
  });

  test("leaves room for the SDK's three cache breakpoints so the API never receives five", async () => {
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
    expect(marked).toHaveLength(1);
    expect(marked[0]?.text).toContain("entry 40");
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

    expect(events).toEqual([
      { type: "usage", usage: { input: 12, output: 1, cacheRead: 4, cacheWrite: 0 } },
      { type: "text_delta", text: "Hello" },
      { type: "usage", usage: { input: 12, output: 3, cacheRead: 4, cacheWrite: 0 } },
      { type: "done", reason: "length" },
    ]);
  });

  test("ends the turn at the result without waiting for the SDK to close its stream", async () => {
    let closed = false;
    const runSdkQuery: RunSdkQuery = async function* () {
      try {
        yield resultMessage();
        await new Promise(() => undefined);
      } finally {
        closed = true;
      }
    };

    expect(await runTurn(runSdkQuery)).toEqual([{ type: "done", reason: "stop" }]);
    expect(closed).toBe(true);
  });

  test("aborts the SDK query once the turn is over so no subprocess outlives it", async () => {
    let sdkSignal: AbortSignal | undefined;
    const runSdkQuery: RunSdkQuery = async function* (params) {
      sdkSignal = params.options?.abortController?.signal;
      yield resultMessage();
    };

    await runTurn(runSdkQuery);

    expect(sdkSignal?.aborted).toBe(true);
  });

  test("an unsupported image kept in transcript history does not throw on a later turn", async () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "What format is this?" },
          { type: "image", data: "dW5zdXBwb3J0ZWQ=", mimeType: "image/bmp" },
        ],
      },
    ];
    const turn = (history: ReadonlyArray<unknown>) =>
      runTurn(
        async function* ({ prompt }) {
          await drain(sdkPromptFixture(prompt));
          yield resultMessage();
        },
        buildAgentRequest(contextFixture({ systemPrompt: "s", messages: history, tools: [] })),
      );

    expect(await turn(messages)).toEqual([{ type: "done", reason: "stop" }]);
    expect(await turn([...messages, { role: "user", content: "Never mind, thanks" }])).toEqual([
      { type: "done", reason: "stop" },
    ]);
  });
});

describe("model observation", () => {
  const observe = async (...messages: ReadonlyArray<unknown>) => {
    const observations: ModelObservation[] = [];
    const events = await runTurn(queryWith([], ...messages), requestFixture(), {
      modelObserver: (observation) => observations.push(observation),
    });
    return { events, observations };
  };

  test("reports the first main-loop model and its context window from a completed turn", async () => {
    const usage = { input_tokens: 1, output_tokens: 1 };
    const { events, observations } = await observe(
      streamEvent({ type: "message_start", message: { model: "claude-sonnet-5", usage } }),
      { type: "assistant", message: { model: "claude-haiku-4-5-20251001", usage } },
      resultMessage({
        modelUsage: {
          "claude-haiku-4-5-20251001": {
            canonicalModel: "claude-haiku-4-5",
            contextWindow: 200_000,
          },
          "claude-sonnet-5": { canonicalModel: "claude-sonnet-5", contextWindow: 1_000_000 },
        },
      }),
    );

    expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
    expect(observations).toEqual([
      { selector: "sonnet", canonicalModel: "claude-sonnet-5", contextWindow: 1_000_000 },
    ]);
  });

  test("reports no observation when the turn named no model", async () => {
    const { events, observations } = await observe(resultMessage());

    expect(events).toEqual([{ type: "done", reason: "stop" }]);
    expect(observations).toEqual([]);
  });
});

describe("deferred tool calls", () => {
  test("yields every hook-captured tool call once the SDK result confirms a clean defer", async () => {
    const second = { name: "read", arguments: { path: "README.md" } };

    const events = await runTurn(queryWith([READ_PACKAGE, second], DEFERRED));

    expect(events).toEqual([
      {
        type: "tool_calls",
        calls: [
          { id: "toolu_0", ...READ_PACKAGE },
          { id: "toolu_1", ...second },
        ],
      },
    ]);
  });

  test("keeps each turn's allowed-tool set independent even though the MCP schema and handler are shared module singletons", async () => {
    const turn = (toolName: string, allowed: string, ...messages: ReadonlyArray<unknown>) =>
      runTurn(
        queryWith([{ name: toolName, arguments: {} }], ...messages),
        requestFixture({ toolNames: new Set([allowed]) }),
      );

    expect(await turn("read", "read", DEFERRED)).toEqual([
      { type: "tool_calls", calls: [{ id: "toolu_0", name: "read", arguments: {} }] },
    ]);
    expect(await turn("write", "write", DEFERRED)).toEqual([
      { type: "tool_calls", calls: [{ id: "toolu_0", name: "write", arguments: {} }] },
    ]);
    // A tool valid in an earlier turn is denied here, and a denial alone is not fatal.
    expect(await turn("read", "write", resultMessage())).toEqual([
      { type: "done", reason: "stop" },
    ]);
  });

  test("lets the model retry after an invalid pi_call within the same query instead of ending the turn", async () => {
    const events = await runTurn(
      queryWith(
        [INVALID_CALL, READ_PACKAGE],
        resultMessage({ stop_reason: null, terminal_reason: "tool_deferred" }),
      ),
    );

    expect(events).toEqual([{ type: "tool_calls", calls: [{ id: "toolu_1", ...READ_PACKAGE }] }]);
  });

  test("tolerates exactly three invalid attempts, whether or not a valid call follows", async () => {
    const invalid = [INVALID_CALL, INVALID_CALL, INVALID_CALL];

    expect(await runTurn(queryWith([...invalid, READ_PACKAGE], DEFERRED))).toEqual([
      { type: "tool_calls", calls: [{ id: "toolu_3", ...READ_PACKAGE }] },
    ]);
    expect(
      await runTurn(queryWith(invalid, resultMessage({ terminal_reason: "completed" }))),
    ).toEqual([{ type: "done", reason: "stop" }]);
  });

  test("aborts the query at the fourth invalid attempt and fails even if a valid call and clean result follow", async () => {
    let abortReason: unknown;
    const runSdkQuery: RunSdkQuery = async function* (params) {
      const inputs = [INVALID_CALL, INVALID_CALL, INVALID_CALL, INVALID_CALL, READ_PACKAGE];
      for (const [index, toolInput] of inputs.entries()) {
        await deliverToolUse(installedHook(params), `toolu_${index}`, toolInput);
      }
      abortReason = params.options?.abortController?.signal.reason;
      yield textDelta("still talking");
      yield DEFERRED;
    };

    const error = failureOf(await runTurn(runSdkQuery));

    expect(error._tag).toBe("InvalidDeferredCallLimitError");
    expect(error.message).toMatch(/pi_call.*is this gateway's own name/);
    expect(abortReason).toBe(error);
  });

  test("reports the invalid-call limit when the aborted SDK query rejects", async () => {
    const runSdkQuery: RunSdkQuery = async function* (params) {
      yield* queryWith([INVALID_CALL, INVALID_CALL, INVALID_CALL, INVALID_CALL])(params);
      throw new Error("This operation was aborted");
    };

    expect(failureOf(await runTurn(runSdkQuery))._tag).toBe("InvalidDeferredCallLimitError");
  });

  test("rejects tool_deferred when the hook captured no Pi call", async () => {
    const error = failureOf(await runTurn(queryWith([], DEFERRED)));

    expect(error._tag).toBe("SdkProtocolError");
    expect(error.message).toContain("PreToolUse hook captured no calls");
  });

  test("rejects a captured Pi call unless the result confirms tool_deferred", async () => {
    const missing = failureOf(await runTurn(queryWith([READ_PACKAGE], resultMessage())));
    const completed = failureOf(
      await runTurn(queryWith([READ_PACKAGE], resultMessage({ terminal_reason: "completed" }))),
    );

    expect(missing._tag).toBe("SdkProtocolError");
    expect(missing.message).toContain("terminal_reason was missing");
    expect(completed.message).toContain("terminal_reason was completed");
  });
});

describe("turn failures", () => {
  test("returns an SDK result error even after the hook captured a deferred call", async () => {
    const error = failureOf(
      await runTurn(
        queryWith(
          [READ_PACKAGE],
          resultMessage({
            is_error: true,
            stop_reason: null,
            terminal_reason: "tool_deferred_unavailable",
            errors: ["the SDK could not honor the deferred tool call"],
          }),
        ),
      ),
    );

    expect(error._tag).toBe("SdkResultError");
    expect(error.message).toBe("the SDK could not honor the deferred tool call");
  });

  test("does not execute a captured tool call when SDK iteration fails", async () => {
    const runSdkQuery: RunSdkQuery = async function* (params) {
      yield* queryWith([READ_PACKAGE])(params);
      throw new Error("transport disconnected");
    };

    const error = failureOf(await runTurn(runSdkQuery));

    expect(error).toMatchObject({ _tag: "SdkQueryError", operation: "iterate" });
    expect(error.message).toContain("transport disconnected");
  });

  test("reports a query that cannot start", async () => {
    const error = failureOf(
      await runTurn(() => {
        throw new Error("claude executable not found");
      }),
    );

    expect(error).toMatchObject({ _tag: "SdkQueryError", operation: "start" });
  });

  test("fails on a malformed SDK message and stops the query", async () => {
    let closed = false;
    const runSdkQuery: RunSdkQuery = async function* () {
      try {
        yield streamEvent({ type: "message_delta", usage: { output_tokens: "two" } });
        yield resultMessage();
      } finally {
        closed = true;
      }
    };

    expect(failureOf(await runTurn(runSdkQuery))._tag).toBe("SdkProtocolError");
    expect(closed).toBe(true);
  });

  test("fails when SDK iteration ends without a terminal result", async () => {
    const runSdkQuery = queryWith([], textDelta("Truncated"));

    const events = await runTurn(runSdkQuery);

    expect(events[0]).toEqual({ type: "text_delta", text: "Truncated" });
    expect(failureOf(events.slice(1))).toMatchObject({
      _tag: "SdkQueryError",
      operation: "terminal-result",
    });
  });
});

describe("SDK query cancellation", () => {
  test("does not start an SDK query for an already-aborted signal", async () => {
    let queryStarted = false;
    const controller = new AbortController();
    controller.abort("cancelled before start");

    const events = await runTurn(
      () => {
        queryStarted = true;
        return (async function* () {})();
      },
      requestFixture(),
      { signal: controller.signal },
    );

    expect(queryStarted).toBe(false);
    expect(failureOf(events)).toMatchObject({ _tag: "SdkQueryError", operation: "start" });
  });

  test("forwards cancellation during iteration and ends Pi with one aborted event", async () => {
    let markTextYielded = (): void => undefined;
    const textYielded = new Promise<void>((resolve) => {
      markTextYielded = resolve;
    });
    let sdkSignal: AbortSignal | undefined;
    const runSdkQuery: RunSdkQuery = async function* (params) {
      const signal = params.options?.abortController?.signal;
      if (!signal) throw new Error("test setup: SDK abort signal missing");
      sdkSignal = signal;
      yield textDelta("Partial");
      markTextYielded();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const controller = new AbortController();
    const context = contextFixture({
      systemPrompt: "Be concise.",
      messages: [{ role: "user", content: "Hello" }],
      tools: [],
    });
    const eventsPromise = drain(
      createAgentSdkStream(
        sonnet,
        context,
        { signal: controller.signal },
        createClaudeAgentSdkRunner({ runSdkQuery }),
      ),
    );
    await textYielded;
    const cancellationReason = new Error("cancelled by test");

    controller.abort(cancellationReason);
    const events = await eventsPromise;

    expect(sdkSignal?.reason).toBe(cancellationReason);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "error",
    ]);
    const terminal = events.at(-1);
    if (terminal?.type !== "error") throw new Error("test setup: expected Pi error event");
    expect(terminal.reason).toBe("aborted");
    expect(terminal.error.content).toEqual([{ type: "text", text: "Partial" }]);
  });
});

describe("cache diagnostics", () => {
  const usage = streamEvent({
    type: "message_delta",
    usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 95 },
  });
  const diagnose = async (...messages: ReadonlyArray<unknown>) => {
    const diagnostics: CacheDiagnostic[] = [];
    await runTurn(queryWith([], ...messages), requestFixture({ cacheBreakpoint: 0 }), {
      cacheDiagnostics: createCacheDiagnosticTracker((diagnostic) => diagnostics.push(diagnostic)),
    });
    return diagnostics;
  };

  test("records the request and the final usage of a completed turn", async () => {
    expect(await diagnose(usage, resultMessage())).toMatchObject([
      { type: "request", turn: 1, model: "claude-sdk/claude-5-sonnet", breakpointBlock: 0 },
      { type: "usage", turn: 1, input: 5, cacheRead: 95, cacheReadPercent: 95 },
    ]);
  });

  test("records no usage for a failed turn", async () => {
    const diagnostics = await diagnose(usage, resultMessage({ is_error: true }));

    expect(diagnostics.map((diagnostic) => diagnostic.type)).toEqual(["request"]);
  });
});
