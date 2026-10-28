import process from "node:process";
import { isContextOverflow } from "@earendil-works/pi-ai";
import type { AssistantMessageEvent, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Effect, Result } from "effect";
import { afterEach, assert, describe, expect, test, vi } from "vitest";
import { buildAgentRequest } from "../agent-request";
import { createAgentSdkStream } from "../bridge";
import type { CacheDiagnostic } from "../cache-tracker";
import { createCacheDiagnosticTracker } from "../cache-tracker";
import { parseSdkMessage } from "../sdk/messages";
import { createClaudeAgentSdkRunner } from "../sdk/runner";
import type { RunnerOptions, RunSdkQuery } from "../sdk/runner";
import {
  contextFixture,
  deliverToolUses,
  drain,
  installedHook,
  requestFixture,
  resultMessage,
  sdkContentRecords,
  sdkPromptFixture,
  sonnet,
  textBlock,
  textDelta,
  unsettled,
} from "./fixtures";

const PRIVATE = "SYNTHETIC_PRIVATE_SENTINEL";
const context = contextFixture({
  messages: [{ role: "user", content: "offline fixture" }],
  tools: [
    { name: "read", description: "Read fixture", parameters: { type: "object", properties: {} } },
  ],
});
const payload = { promptBlocks: [textBlock("replacement")], cacheBreakpoints: [0] };

function terminalOf(events: readonly AssistantMessageEvent[]) {
  const terminal = events.at(-1);
  assert(terminal?.type === "done" || terminal?.type === "error");
  return terminal.type === "done" ? terminal.message : terminal.error;
}

async function turn(
  query: RunSdkQuery,
  options: SimpleStreamOptions = {},
  collaborators: RunnerOptions = {},
) {
  const run = createClaudeAgentSdkRunner({
    sdkEnvironment: { PATH: "/bin" },
    ...collaborators,
    runSdkQuery: query,
  });
  const events = await drain(createAgentSdkStream({ model: sonnet, context, options, run }));
  expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
  return terminalOf(events);
}

function messagesQuery(...messages: readonly unknown[]): RunSdkQuery {
  return async function* () {
    yield* messages;
  };
}

function serverNames(options: Parameters<RunSdkQuery>[0]["options"]) {
  return Object.keys(requiredOptions(options).mcpServers ?? {});
}
function assertObject(value: unknown): asserts value is object {
  assert(typeof value === "object" && value !== null);
}
function firstObjectField(data: object, key: string): object {
  const value: unknown = Reflect.get(data, key);
  assert(Array.isArray(value));
  const first: unknown = value[0];
  assertObject(first);
  return first;
}
function requiredOptions(options: Parameters<RunSdkQuery>[0]["options"]) {
  assert(options);
  return options;
}

function sdkErrorDetail(isArray: boolean, detail: string) {
  return isArray ? [detail, 42] : detail;
}
function chooseReplacement(replace: boolean, original: unknown) {
  return replace ? payload : original;
}
async function rejectPrivate(): Promise<never> {
  throw new Error(PRIVATE);
}
function phaseSignal(phase: string): true | undefined {
  return phase === "event" ? true : undefined;
}

function phaseOptions(phase: string, hook: () => Promise<undefined>): SimpleStreamOptions {
  return phase === "payload" ? { onPayload: hook } : { onProviderStreamEvent: hook };
}

function safeError(message: ReturnType<typeof terminalOf>, lines: readonly string[]) {
  expect(message.stopReason).toBe("error");
  expect(message.errorMessage?.length).toBeLessThan(180);
  expect(JSON.stringify([message, lines])).not.toContain(PRIVATE);
}

function captureDiagnostics() {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((line) => {
    lines.push(String(line));
    return true;
  });
  return lines;
}

describe("public terminal failure privacy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test.each([
    ["errors", true],
    ["result", false],
  ] as const)(
    "discards arbitrary %s text through parser, real runner and Pi bridge",
    async (field, isArray) => {
      const lines = captureDiagnostics();
      const detail = `${PRIVATE}${"arbitrary private text ".repeat(20_000)}`;
      const sdkResult = resultMessage({
        is_error: true,
        [field]: sdkErrorDetail(isArray, detail),
        terminal_reason: detail,
      });
      const parsed = parseSdkMessage(sdkResult);
      assert(Result.isSuccess(parsed));
      expect(JSON.stringify(parsed)).not.toContain(PRIVATE);
      const message = await turn(messagesQuery(sdkResult));
      safeError(message, lines);
      expect(message.errorMessage).toContain("the query failed; retry or check Claude Code status");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"terminalReason":"unrecognized"');
    },
  );

  test.each([
    [{ terminal_reason: "blocking_limit" }, "usage limit reached", "usage-limit"],
    [
      { terminal_reason: "tool_deferred_unavailable", is_error: false },
      "back to Pi",
      "tool-contract",
    ],
    [{ stop_reason: "refusal", is_error: false }, "model refused", "provider"],
    [{ terminal_reason: "prompt_too_long" }, "context_length_exceeded", "provider"],
    [{ terminal_reason: "budget_exhausted" }, "budget limit", "provider"],
    [{ terminal_reason: "max_turns" }, "turn limit", "provider"],
    [{ terminal_reason: "structured_output_retry_exhausted" }, "output limit", "provider"],
    [{ terminal_reason: "aborted_tools" }, "cancelled", "cancelled"],
    [{ terminal_reason: "image_error" }, "check model and input", "provider"],
    [{ subtype: "error_max_turns" }, "turn limit", "provider"],
    [{ subtype: "error_max_budget_usd" }, "budget limit", "provider"],
    [{ subtype: "error_max_structured_output_retries" }, "output limit", "provider"],
  ] as const)(
    "keeps actionable structured result categories: %j",
    async (fields, summary, kind) => {
      const lines = captureDiagnostics();
      const message = await turn(
        messagesQuery(
          resultMessage({ is_error: true, errors: [PRIVATE], result: PRIVATE, ...fields }),
        ),
      );
      safeError(message, lines);
      expect(message.errorMessage).toContain(summary);
      expect(lines[0]).toContain(`"kind":"${kind}"`);
    },
  );

  test.each([
    ["authentication_failed", "sign in", "authentication"],
    ["rate_limit", "rate limit", "rate-limit"],
    ["overloaded", "overloaded", "provider"],
    ["invalid_request", "check model and input", "provider"],
    ["max_output_tokens", "output limit", "provider"],
    [PRIVATE, "query failed", "provider"],
  ])("keeps typed API categories without copying raw details: %s", async (error, summary, kind) => {
    const lines = captureDiagnostics();
    const message = await turn(
      messagesQuery(
        { type: "assistant", error, message: { usage: {} } },
        resultMessage({ is_error: true, errors: [PRIVATE], result: PRIVATE }),
      ),
    );
    safeError(message, lines);
    expect(message.errorMessage).toContain(summary);
    expect(lines[0]).toContain(`"kind":"${kind}"`);
  });

  test.each(["unknown", "invalid_request"])(
    "retains terminal overflow recovery despite generic API error %s",
    async (error) => {
      const lines = captureDiagnostics();
      const message = await turn(
        messagesQuery(
          { type: "assistant", error, message: { usage: {} } },
          resultMessage({
            is_error: true,
            terminal_reason: "prompt_too_long",
            errors: [PRIVATE],
            result: PRIVATE,
          }),
        ),
      );
      safeError(message, lines);
      expect(message.errorMessage).toContain("context_length_exceeded");
      expect(isContextOverflow(message)).toBe(true);
    },
  );

  test.each([
    ["blocking_limit", "usage limit", "usage-limit"],
    ["tool_deferred_unavailable", "back to Pi", "tool-contract"],
    ["budget_exhausted", "budget limit", "provider"],
    ["max_turns", "turn limit", "provider"],
    ["structured_output_retry_exhausted", "output limit", "provider"],
    ["aborted_tools", "cancelled", "cancelled"],
    ["image_error", "check model and input", "provider"],
  ])("terminal %s remains authoritative over generic API errors", async (reason, summary, kind) => {
    const lines = captureDiagnostics();
    const messages = await Promise.all(
      ["unknown", "invalid_request"].map(async (error) =>
        turn(
          messagesQuery(
            { type: "assistant", error, message: { usage: {} } },
            resultMessage({ is_error: true, terminal_reason: reason, errors: [PRIVATE] }),
          ),
        ),
      ),
    );
    for (const message of messages) {
      safeError(message, lines);
      expect(message.errorMessage).toContain(summary);
      expect(isContextOverflow(message)).toBe(false);
    }
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.includes(`"kind":"${kind}"`))).toBe(true);
  });

  test.each(["authentication_failed", "oauth_org_not_allowed", "cloud_credential_error"])(
    "authentication %s still outranks terminal overflow",
    async (error) => {
      const lines = captureDiagnostics();
      const message = await turn(
        messagesQuery(
          { type: "assistant", error, message: { usage: {} } },
          resultMessage({ is_error: true, terminal_reason: "prompt_too_long", errors: [PRIVATE] }),
        ),
      );
      safeError(message, lines);
      expect(message.errorMessage).toContain("sign in");
      expect(isContextOverflow(message)).toBe(false);
      expect(lines[0]).toContain('"kind":"authentication"');
    },
  );

  test.each([
    [resultMessage({ stop_reason: PRIVATE }), "unsupported stop_reason"],
    [resultMessage({ stop_reason: "tool_deferred" }), "captured no calls"],
  ])("bounds related protocol errors: %j", async (sdkResult, summary) => {
    const lines = captureDiagnostics();
    const message = await turn(messagesQuery(sdkResult));
    safeError(message, lines);
    expect(message.errorMessage).toContain(summary);
  });

  test("does not echo an unknown terminal reason with captured calls", async () => {
    const lines = captureDiagnostics();
    const message = await turn(async function* (params) {
      await deliverToolUses(installedHook(params), [
        { id: "read", input: { name: "read", arguments: {} } },
      ]);
      yield resultMessage({ terminal_reason: PRIVATE });
    });
    safeError(message, lines);
    expect(message.errorMessage).toContain("terminal_reason was unrecognized");
  });

  test("does not copy rejected query signal or raw cause into Pi or diagnostics", async () => {
    const lines = captureDiagnostics();
    const message = await turn(() => {
      throw Object.assign(new Error(PRIVATE), {
        errorClass: "process_killed_by_signal",
        signal: PRIVATE,
      });
    });
    safeError(message, lines);
    expect(message.errorMessage).toContain("unexpected SDK error");
  });

  test("unprotected invalid-tool failures do not copy model-supplied names", async () => {
    const lines = captureDiagnostics();
    const message = await turn(async function* (params) {
      await deliverToolUses(
        installedHook(params),
        Array.from({ length: 4 }, (_, i) => ({
          id: String(i),
          input: { name: PRIVATE, arguments: {} },
        })),
      );
      yield resultMessage();
    });
    safeError(message, lines);
    expect(message.errorMessage).toContain("could not hand the requested Pi tool call back to Pi");
  });
});

describe("public SDK-adapted instrumentation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("awaits payload once and every parsed SDK object in order before normalization; HTTP facts remain unavailable", async () => {
    const order: string[] = [];
    let responseCalls = 0;
    const sdkEvents = [{ type: "system", subtype: "init" }, textDelta("hello"), resultMessage()];
    const message = await turn(
      async function* () {
        order.push("query");
        for (const event of sdkEvents) {
          order.push("yield");
          yield event;
        }
        order.push("late");
      },
      {
        onPayload: async (_payload, model) => {
          expect(model).toBe(sonnet);
          order.push("payload");
          await Promise.resolve();
          order.push("payload-end");
        },
        onResponse: () => {
          responseCalls++;
        },
        onProviderStreamEvent: async (event, model) => {
          expect(model).toBe(sonnet);
          expect(event).toBe(sdkEvents[order.filter((entry) => entry === "event").length]);
          order.push("event");
          await Promise.resolve();
          order.push("event-end");
        },
      },
    );
    expect(order).toStrictEqual([
      "payload",
      "payload-end",
      "query",
      "yield",
      "event",
      "event-end",
      "yield",
      "event",
      "event-end",
      "yield",
      "event",
      "event-end",
    ]);
    expect(responseCalls).toBe(0);
    expect(message.content).toStrictEqual([{ type: "text", text: "hello" }]);
  });

  test.each([false, true])(
    "honors %s mutation/replacement and tracks the applied prompt and breakpoint",
    async (replace) => {
      const diagnostics: CacheDiagnostic[] = [];
      let wire: Record<string, unknown>[] = [];
      const message = await turn(
        async function* ({ prompt, options }) {
          const [sdkPrompt] = await drain(sdkPromptFixture(prompt));
          wire = sdkContentRecords(sdkPrompt);
          expect(options).toMatchObject({
            model: "sonnet",
            env: { PATH: "/bin" },
            tools: [],
            settingSources: [],
            persistSession: false,
            systemPrompt: buildAgentRequest(context).systemPrompt,
          });
          expect(serverNames(options)).toStrictEqual(["pi"]);
          yield resultMessage({ usage: { input_tokens: 1 } });
        },
        {
          onPayload: (original) => {
            assertObject(original);
            expect(Object.keys(original)).toStrictEqual(["promptBlocks", "cacheBreakpoints"]);
            Object.assign(original, payload);
            return chooseReplacement(replace, undefined);
          },
        },
        {
          cacheDiagnostics: Effect.runSync(
            createCacheDiagnosticTracker((record) => {
              diagnostics.push(record);
            }),
          ),
        },
      );
      expect(message.stopReason).toBe("stop");
      expect(wire).toStrictEqual([
        { type: "text", text: "replacement", cache_control: { type: "ephemeral" } },
      ]);
      expect(diagnostics[0]).toMatchObject({
        type: "request",
        blocks: 1,
        textCharacters: 11,
        breakpoints: [0],
      });
      expect(JSON.stringify(diagnostics)).not.toContain("replacement");
      expect(diagnostics.map((record) => record.type)).toStrictEqual(["request", "usage"]);
    },
  );

  test("forwards validated replacement images and null cache boundary", async () => {
    let wire: Record<string, unknown>[] = [];
    await turn(
      async function* ({ prompt }) {
        const [message] = await drain(sdkPromptFixture(prompt));
        wire = sdkContentRecords(message);
        yield resultMessage();
      },
      {
        onPayload: () => ({
          promptBlocks: [textBlock("image", [{ data: "fixture", mediaType: "image/png" }])],
          cacheBreakpoints: [],
        }),
      },
    );
    expect(wire).toStrictEqual([
      { type: "text", text: "image" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "fixture" } },
    ]);
  });

  test.each([
    null,
    {},
    { ...payload, cacheBreakpoints: [-1] },
    { ...payload, cacheBreakpoints: [1] },
    { ...payload, cacheBreakpoints: [0, 0] },
    { ...payload, cacheBreakpoints: [0, 0, 0, 0, 0] },
    { ...payload, promptBlocks: [] },
    { ...payload, promptBlocks: [{ text: 7, images: [] }] },
    { ...payload, promptBlocks: [textBlock("x", [{ data: "x", mediaType: "" }])] },
    ...[
      "env",
      "model",
      "hooks",
      "abortController",
      "permissions",
      "persistSession",
      "tools",
      "systemPrompt",
      "toolNames",
      "options",
    ].map((key) => ({ ...payload, [key]: PRIVATE })),
  ])(
    "rejects invalid/control-plane replacements before starting query: %j",
    async (replacement) => {
      const lines = captureDiagnostics();
      let started = 0;
      const message = await turn(
        (params) => {
          started++;
          return messagesQuery(resultMessage())(params);
        },
        { onPayload: () => replacement },
      );
      safeError(message, lines);
      expect(message.errorMessage).toContain("invalid SDK-adapted payload");
      expect(started).toBe(0);
      expect(lines[0]).toContain('"errorTag":"SdkInstrumentationError"');
    },
  );

  test.each(["payload", "event"])(
    "sanitizes %s callback rejection and closes query when opened",
    async (phase) => {
      const lines = captureDiagnostics();
      let opened = false;
      let closed = false;

      const message = await turn(
        async function* () {
          opened = true;
          try {
            yield textDelta("not normalized");
            yield resultMessage();
          } finally {
            closed = true;
          }
        },
        {
          ...phaseOptions(phase, rejectPrivate),
        },
      );
      safeError(message, lines);
      expect(message.content).toStrictEqual([]);
      expect(opened).toBe(phase === "event");
      expect(closed).toBe(opened);
    },
  );

  test("a read-only payload observer preserves unsupported historical image fallback", async () => {
    const historical = contextFixture({
      messages: [
        { role: "user", content: [{ type: "image", data: "fixture", mimeType: "image/bmp" }] },
      ],
      tools: [],
    });
    const run = createClaudeAgentSdkRunner({
      sdkEnvironment: { PATH: "/bin" },
      async *runSdkQuery({ prompt }) {
        const [message] = await drain(sdkPromptFixture(prompt));
        expect(JSON.stringify(sdkContentRecords(message))).toContain("image/bmp");
        yield resultMessage();
      },
    });
    const events = await drain(
      createAgentSdkStream({
        model: sonnet,
        context: historical,
        options: { onPayload: () => undefined },
        run,
      }),
    );
    expect(terminalOf(events).stopReason).toBe("stop");
  });

  test("payload mutation is isolated from the original request, including nested images", async () => {
    const original = requestFixture({
      promptBlocks: [textBlock("original", [{ data: "fixture", mediaType: "image/png" }])],
      cacheBreakpoints: [0],
    });
    const snapshot = structuredClone(original);
    const run = createClaudeAgentSdkRunner({
      sdkEnvironment: { PATH: "/bin" },
      async *runSdkQuery({ prompt }) {
        const [message] = await drain(sdkPromptFixture(prompt));
        expect(sdkContentRecords(message)).toMatchObject([
          { text: "edited" },
          { source: { data: "edited-image" } },
        ]);
        yield resultMessage();
      },
    });
    await drain(
      run(original, sonnet, {
        onPayload: (data) => {
          assertObject(data);
          const block = firstObjectField(data, "promptBlocks");
          Object.assign(block, { text: "edited" });
          const image = firstObjectField(block, "images");
          Object.assign(image, { data: "edited-image" });
        },
      }),
    );
    expect(original).toStrictEqual(snapshot);
  });

  test("a callback failure after tool capture never releases the deferred call", async () => {
    const lines = captureDiagnostics();
    const message = await turn(
      async function* (params) {
        await deliverToolUses(installedHook(params), [
          { id: "read", input: { name: "read", arguments: {} } },
        ]);
        yield resultMessage({ terminal_reason: "tool_deferred" });
      },
      { onProviderStreamEvent: rejectPrivate },
    );
    safeError(message, lines);
    expect(message.content).toStrictEqual([]);
    expect(message.errorMessage).toContain("instrumentation");
  });

  test("abandoning an awaited payload callback starts no SDK query", async () => {
    const entered = Promise.withResolvers<undefined>();
    let opened = 0;
    const run = createClaudeAgentSdkRunner({
      sdkEnvironment: { PATH: "/bin" },
      runSdkQuery: (params) => {
        opened++;
        return messagesQuery(resultMessage())(params);
      },
    });
    const iterator = run(buildAgentRequest(context), sonnet, {
      onPayload: async () => {
        entered.resolve(undefined);
        return unsettled();
      },
    })[Symbol.asyncIterator]();
    const next = iterator.next();
    await entered.promise;
    await iterator.return?.();
    await next;
    expect(opened).toBe(0);
  }, 1000);

  test("observes a malformed parsed SDK event before provider validation", async () => {
    const raw = { type: "result", is_error: PRIVATE };
    const seen: unknown[] = [];
    const message = await turn(messagesQuery(raw), {
      onProviderStreamEvent: async (event) => {
        seen.push(event);
      },
    });
    expect(seen).toStrictEqual([raw]);
    expect(message.errorMessage).toContain("malformed result");
    expect(message.errorMessage).not.toContain(PRIVATE);
  });

  test.each(["payload", "event"])(
    "cancels a pending %s callback promptly, observes late rejection and cleans up",
    async (phase) => {
      const lines = captureDiagnostics();
      const entered = Promise.withResolvers<undefined>();
      const pending = Promise.withResolvers<undefined>();
      const controller = new AbortController();
      let opened = false;
      let closed = false;
      let sdkSignal: AbortSignal | undefined;
      const wait = async () => {
        entered.resolve(undefined);
        return pending.promise;
      };
      const result = turn(
        async function* (params) {
          opened = true;
          sdkSignal = params.options?.abortController?.signal;
          try {
            yield textDelta("not normalized");
            yield resultMessage();
          } finally {
            closed = true;
          }
        },
        {
          signal: controller.signal,
          ...phaseOptions(phase, wait),
        },
      );
      await entered.promise;
      controller.abort(new Error(PRIVATE));
      const message = await result;
      pending.reject(new Error(PRIVATE));
      await Promise.resolve();
      expect(message.stopReason).toBe("aborted");
      expect(message.content).toStrictEqual([]);
      expect(message.errorMessage).not.toContain(PRIVATE);
      expect(JSON.stringify(lines)).not.toContain(PRIVATE);
      expect(opened).toBe(phase === "event");
      expect(closed).toBe(opened);
      expect(sdkSignal?.aborted).toBe(phaseSignal(phase));
    },
  );

  test("pre-cancelled calls invoke neither callback nor query", async () => {
    const controller = new AbortController();
    controller.abort();
    const payloadHook = vi.fn<() => void>();
    const eventHook = vi.fn<() => void>();
    const query = vi.fn<RunSdkQuery>(messagesQuery(resultMessage()));
    const message = await turn(query, {
      signal: controller.signal,
      onPayload: payloadHook,
      onProviderStreamEvent: eventHook,
    });
    expect(message.stopReason).toBe("aborted");
    expect(payloadHook).not.toHaveBeenCalled();
    expect(eventHook).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  test("abandoning the real runner interrupts an awaited event callback and closes an abnormal iterator", async () => {
    const entered = Promise.withResolvers<undefined>();
    let closed = 0;
    let sdkSignal: AbortSignal | undefined;
    const run = createClaudeAgentSdkRunner({
      sdkEnvironment: { PATH: "/bin" },
      runSdkQuery: (params) => {
        sdkSignal = params.options?.abortController?.signal;
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () => ({ done: false, value: textDelta("pending") }),
            return: async () => {
              closed++;
              throw new Error(PRIVATE);
            },
          }),
        };
      },
    });
    const iterator = run(buildAgentRequest(context), sonnet, {
      onProviderStreamEvent: async () => {
        entered.resolve(undefined);
        await unsettled();
      },
    })[Symbol.asyncIterator]();
    const next = iterator.next();
    await entered.promise;
    await iterator.return?.();
    await next;
    expect(closed).toBe(1);
    expect(sdkSignal?.aborted).toBe(true);
  }, 1000);
});
