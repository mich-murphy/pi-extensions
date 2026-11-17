import type { AssistantMessage, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { Result } from "effect";
import { describe, expect, test } from "vitest";
import type { BridgeEvent } from "../bridge";
import {
  InvalidDeferredCallError,
  InvalidDeferredCallLimitError,
  SdkInstrumentationError,
  SdkInternalContinuationError,
  SdkMissingResultError,
  SdkOverageError,
  SdkProtocolError,
  SdkProviderDefect,
  SdkQueryError,
  SdkResultError,
  SdkStreamInterruptedError,
  SdkToolContractError,
} from "../sdk/errors";
import type { SdkTurnFailure } from "../sdk/errors";
import { diagnoseSdkRunError, formatSdkRunError } from "../sdk/failure-diagnostics";
import { parseSdkMessage } from "../sdk/messages";
import { ResultFailureCategory } from "../sdk/result-failure";
import { createClaudeAgentSdkRunner } from "../sdk/runner";
import type { RunSdkQuery } from "../sdk/runner";
import { subscriptionEnvironment } from "../sdk/subscription-environment";
import { drain, requestFixture, resultMessage, sonnet, streamEvent, textDelta } from "./fixtures";

type SdkQueryParameters = Parameters<RunSdkQuery>[0];

// Message sequences below are what Claude Code 2.1.325 emitted against a fault-injecting API.
const start = (id: string) =>
  streamEvent({ type: "message_start", message: { id, usage: { input_tokens: 100 } } });
const stopped = (reason: string) =>
  streamEvent({
    type: "message_delta",
    delta: { stop_reason: reason },
    usage: { output_tokens: 20 },
  });
const blockStop = streamEvent({ type: "content_block_stop", index: 0 });
const messageStop = streamEvent({ type: "message_stop" });
const apiRetry = {
  type: "system",
  subtype: "api_retry",
  attempt: 1,
  max_retries: 10,
  retry_delay_ms: 540,
  error_status: null,
  error: "unknown",
};
const apiErrorAssistant = (error: string) => ({
  type: "assistant",
  message: { usage: {}, content: [{ type: "text", text: "API Error: injected" }] },
  error,
});
const apiErrorResult = resultMessage({
  is_error: true,
  stop_reason: "stop_sequence",
  terminal_reason: "api_error",
});
const completed = [stopped("end_turn"), messageStop, resultMessage()];

type Observed = { params?: SdkQueryParameters; consumedAfterRetry: boolean };

const DEFAULT_ENVIRONMENT: Readonly<Record<string, string | undefined>> = { PATH: "/bin" };

async function runMessages(
  messages: readonly unknown[],
  options: SimpleStreamOptions = {},
  sdkEnvironment = DEFAULT_ENVIRONMENT,
) {
  const observed: Observed = { consumedAfterRetry: false };
  const runner = createClaudeAgentSdkRunner({
    claudeExecutable: "/usr/bin/claude",
    sdkEnvironment,
    async *runSdkQuery(params) {
      observed.params = params;
      let retried = false;
      for (const message of messages) {
        yield message;
        // Anything read after an interrupted attempt's resend is output Pi must never see.
        observed.consumedAfterRetry ||= retried;
        retried ||= message === apiRetry;
      }
    },
  });
  const events = await drain(runner(requestFixture(), sonnet, options));
  return { events, observed };
}

function failure(events: readonly BridgeEvent[]): SdkTurnFailure {
  const last = events.at(-1);
  if (last?.type !== "failed") {
    throw new Error("test setup: expected the turn to fail");
  }
  return last.error;
}

async function failureOf(messages: readonly unknown[]): Promise<SdkTurnFailure> {
  const { events } = await runMessages(messages);
  return failure(events);
}

function textsOf(events: readonly BridgeEvent[]): string[] {
  return events.flatMap((event) => (event.type === "text_delta" ? [event.text] : []));
}

const parse = (input: unknown) => Result.getOrThrow(parseSdkMessage(input));

function retryable(error: SdkTurnFailure): boolean {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "claude",
    provider: "claude",
    model: sonnet.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: formatSdkRunError(error),
    timestamp: 0,
  };
  return isRetryableAssistantError(message);
}

describe("commit point: no resend after output reached Pi", () => {
  test("a cut stream that Claude Code announces as a retry stops the turn as retryable", async () => {
    const { events, observed } = await runMessages([
      start("a"),
      textDelta("PARTIAL"),
      blockStop,
      messageStop,
      apiRetry,
      start("b"),
      textDelta("RESENT"),
      ...completed,
    ]);

    expect(textsOf(events)).toStrictEqual(["PARTIAL"]);
    const error = failure(events);
    expect(error).toMatchObject({ _tag: "SdkStreamInterruptedError", evidence: "api-retry" });
    expect(retryable(error)).toBe(true);
    expect(observed.consumedAfterRetry).toBe(false);
    expect(observed.params?.options?.abortController?.signal.aborted).toBe(true);
  });

  test("a mid-stream overloaded error resends without a retry notice and is still caught", async () => {
    const { events } = await runMessages([
      start("a"),
      textDelta("PARTIAL"),
      blockStop,
      messageStop,
      start("b"),
      textDelta("RESENT"),
      ...completed,
    ]);

    expect(textsOf(events)).toStrictEqual(["PARTIAL"]);
    expect(failure(events)).toMatchObject({
      _tag: "SdkStreamInterruptedError",
      evidence: "new-attempt",
    });
  });

  test("a resend that repeats the same request id is not a new attempt", async () => {
    const { events } = await runMessages([start("a"), textDelta("ok"), start("a"), ...completed]);
    expect(events.at(-1)).toStrictEqual({ type: "done", reason: "stop" });
  });

  test("a retry before any output stays inside Claude Code and the turn succeeds", async () => {
    const { events } = await runMessages([apiRetry, start("b"), textDelta("FINAL"), ...completed]);
    expect(events.filter((event) => event.type !== "usage")).toStrictEqual([
      { type: "text_delta", text: "FINAL" },
      { type: "done", reason: "stop" },
    ]);
  });

  test("an output-limit resume after a completed request stays a non-retryable continuation", async () => {
    const { events } = await runMessages([
      start("a"),
      textDelta("PARTIAL"),
      stopped("max_tokens"),
      messageStop,
      { type: "user", message: { content: [{ type: "text", text: "resume" }] } },
      start("b"),
      textDelta("REST"),
      ...completed,
    ]);
    const error = failure(events);
    expect(error._tag).toBe("SdkInternalContinuationError");
    expect(retryable(error)).toBe(false);
  });

  test("an untyped API error after the response started is a retryable interruption", async () => {
    const { events } = await runMessages([
      start("a"),
      textDelta("PARTIAL"),
      apiErrorAssistant("unknown"),
      stopped("stop_sequence"),
      messageStop,
      apiErrorResult,
    ]);
    const error = failure(events);
    expect(error).toMatchObject({ _tag: "SdkStreamInterruptedError", evidence: "api-error" });
    expect(retryable(error)).toBe(true);
  });

  test("typed and pre-output API errors keep their own category", async () => {
    const typed = await failureOf([start("a"), apiErrorAssistant("server_error"), apiErrorResult]);
    expect(typed).toMatchObject({ _tag: "SdkResultError", apiError: "server_error" });
    expect(retryable(typed)).toBe(true);

    const untypedBeforeOutput = await failureOf([apiErrorAssistant("unknown"), apiErrorResult]);
    expect(untypedBeforeOutput._tag).toBe("SdkResultError");
  });
});

describe("Pi owns retries", () => {
  test.each<[SimpleStreamOptions, string]>([
    [{}, "0"],
    [{ maxRetries: 3 }, "3"],
    [{ maxRetries: 2.7 }, "2"],
    [{ maxRetries: 0 }, "0"],
    [{ maxRetries: -1 }, "0"],
    [{ maxRetries: Number.NaN }, "0"],
    [{ maxRetries: Number.POSITIVE_INFINITY }, "0"],
  ])("Pi options %o give Claude Code %s retries", async (options, expected) => {
    const { observed } = await runMessages(
      [start("a"), ...completed],
      options,
      // An inherited value must never win over Pi's setting.
      { PATH: "/bin", CLAUDE_CODE_MAX_RETRIES: "10" },
    );
    expect(observed.params?.options?.env?.CLAUDE_CODE_MAX_RETRIES).toBe(expected);
  });

  test.each([
    "CLAUDE_CODE_MAX_RETRIES",
    "CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES",
    "CLAUDE_CODE_RETRY_WATCHDOG",
    "CLAUDE_CODE_RETRY_WATCHDOG_SCOPE",
    "CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS",
    "CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS",
    "CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS",
    "CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS",
    "CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS",
    "CLAUDE_CODE_OVERLOADED_RETRY_MAX_WAIT_MS",
  ])("strips the inherited hidden retry override %s", (name) => {
    expect(subscriptionEnvironment({ [name]: "1" })[name]).toBeUndefined();
  });

  test("turns off the refusal retry even when inherited as enabled", () => {
    const environment = subscriptionEnvironment({ CLAUDE_CODE_DISABLE_REFUSAL_RETRY: "0" });
    expect(environment.CLAUDE_CODE_DISABLE_REFUSAL_RETRY).toBe("1");
  });
});

describe("stream lifecycle parsing", () => {
  test("reads retry notices and real stop reasons without retaining their payloads", () => {
    expect(parse(apiRetry)).toStrictEqual({ type: "api_retry" });
    expect(parse({ type: "system", subtype: "init" })).toStrictEqual({ type: "ignored" });
    expect(parse({ type: "system" })).toStrictEqual({ type: "ignored" });
    expect(parse(stopped("end_turn"))).toMatchObject({ type: "usage", requestStopped: true });
  });

  test.each([null, ""])("a stop reason of %o does not complete the request", (reason) => {
    expect(
      parse(streamEvent({ type: "message_delta", delta: { stop_reason: reason }, usage: {} })),
    ).not.toHaveProperty("requestStopped");
  });

  test("diagnoses an interruption with its evidence and nothing else", () => {
    expect(
      diagnoseSdkRunError(new SdkStreamInterruptedError({ evidence: "api-retry" })),
    ).toStrictEqual({
      schemaVersion: 1,
      kind: "stream-interrupted",
      errorTag: "SdkStreamInterruptedError",
      streamInterruption: "api-retry",
    });
  });
});

// Pi decides whether to retry by matching error text. Every message the provider can produce is
// checked against Pi's installed classifier, so wording or a Pi upgrade cannot silently change it.
const queryReasons = [
  { _tag: "Cancelled" },
  { _tag: "ExecutableNotFound" },
  { _tag: "ExecutableLaunchFailed" },
  { _tag: "ClaudeCodeTooOld", version: "2.0.0" },
  { _tag: "WorkingDirectoryUnavailable" },
  { _tag: "ProcessExited", exitCode: 1 },
  { _tag: "ProcessKilled", signal: "SIGTERM" },
  { _tag: "ProcessKilled", signal: "SIGKILL" },
  { _tag: "Unclassified" },
] as const;
const RETRYABLE_RESULT_CATEGORIES = new Set(["rate-limit", "server-error", "overloaded"]);

const failuresByTag = {
  SdkStreamInterruptedError: [
    new SdkStreamInterruptedError({ evidence: "api-retry" }),
    new SdkStreamInterruptedError({ evidence: "new-attempt" }),
    new SdkStreamInterruptedError({ evidence: "api-error" }),
  ],
  SdkInternalContinuationError: [new SdkInternalContinuationError()],
  SdkMissingResultError: [new SdkMissingResultError()],
  SdkQueryError: (["start", "iterate"] as const).flatMap((operation) =>
    queryReasons.map((reason) => new SdkQueryError({ operation, reason, cause: new Error("x") })),
  ),
  SdkResultError: ResultFailureCategory.literals.map(
    (category) => new SdkResultError({ terminalReason: undefined, category }),
  ),
  SdkProtocolError: [
    new SdkProtocolError({ messageType: "result", detail: "unsupported stop_reason" }),
  ],
  SdkToolContractError: [
    new SdkToolContractError({ reason: "naming" }),
    new SdkToolContractError({ reason: "schema" }),
  ],
  InvalidDeferredCallLimitError: [
    new InvalidDeferredCallLimitError({
      attempts: 4,
      lastError: new InvalidDeferredCallError({ requestedName: "x", reason: "unknown tool" }),
    }),
  ],
  SdkOverageError: [new SdkOverageError({ resetsAt: undefined })],
  SdkInstrumentationError: (["payload", "replacement", "event", "cancelled"] as const).map(
    (operation) => new SdkInstrumentationError({ operation }),
  ),
  SdkProviderDefect: [
    new SdkProviderDefect({ reason: "no-terminal-event" }),
    new SdkProviderDefect({ reason: "run-rejected" }),
  ],
} satisfies Readonly<Record<SdkTurnFailure["_tag"], readonly SdkTurnFailure[]>>;

/** Only broken streams and transient API result categories should be retried by Pi. */
function intendedRetry(error: SdkTurnFailure): boolean {
  return (
    error._tag === "SdkStreamInterruptedError" ||
    (error._tag === "SdkResultError" && RETRYABLE_RESULT_CATEGORIES.has(error.category))
  );
}

describe("Pi retry contract", () => {
  test.each(
    Object.values(failuresByTag)
      .flat()
      .map((error) => [formatSdkRunError(error), error]),
  )("%s", (_message, error) => {
    expect(retryable(error)).toBe(intendedRetry(error));
  });
});
