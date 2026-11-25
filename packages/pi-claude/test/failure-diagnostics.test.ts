import { AbortError } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { describe, expect, test } from "vitest";
import {
  InvalidDeferredCallError,
  InvalidDeferredCallLimitError,
  SdkMissingResultError,
  SdkInternalContinuationError,
  SdkProtocolError,
  SdkProviderDefect,
  SdkQueryError,
  SdkQueryFailureReason,
  SdkResultError,
  SdkStreamInterruptedError,
  SdkToolContractError,
} from "../sdk/errors";
import {
  diagnoseSdkRunError,
  formatSdkRunError,
  writeSdkFailureDiagnostic,
} from "../sdk/failure-diagnostics";
import { ResultFailureCategory } from "../sdk/result-failure";

type ProcessFailure = {
  readonly errorClass: string;
  readonly exitCode?: number;
  readonly signal?: string;
};

function sdkRejection(message: string, fields: ProcessFailure): Error {
  return Object.assign(new Error(message), fields);
}

const outOfUsage = new SdkResultError({
  terminalReason: undefined,
  category: "usage-limit",
});

describe("claude SDK failure diagnostics", () => {
  test.each([
    [new SdkInternalContinuationError(), "internal-continuation"],
    [
      new SdkProtocolError({ messageType: "result", detail: "unsupported stop_reason future" }),
      "protocol",
    ],
    [
      new InvalidDeferredCallLimitError({
        attempts: 4,
        lastError: new InvalidDeferredCallError({ requestedName: "missing", reason: "unknown" }),
      }),
      "tool-contract",
    ],
    [outOfUsage, "usage-limit"],
    [SdkQueryError.fromCause("iterate", new Error("getaddrinfo ENOTFOUND api.example")), "network"],
    [SdkQueryError.fromCause("iterate", new Error("Request timed out")), "timeout"],
    [
      SdkQueryError.fromCause("iterate", new Error("Your computer went to sleep mid-response")),
      "host-sleep",
    ],
    [SdkQueryError.fromCause("iterate", new Error("This operation was aborted")), "cancelled"],
    [SdkQueryError.cancelled("start", "stop"), "cancelled"],
    [new SdkResultError({ terminalReason: "model_error", category: "provider" }), "provider"],
    [new SdkMissingResultError(), "provider"],
    [new SdkProviderDefect({ reason: "no-terminal-event" }), "defect"],
    [
      new SdkResultError({
        terminalReason: undefined,
        category: "provider",
        apiError: "authentication_failed",
      }),
      "authentication",
    ],
  ] as const)("classifies %s as %s", (error, expectedKind) => {
    expect(diagnoseSdkRunError(error).kind).toBe(expectedKind);
  });

  test.each([
    ["naming", "Two tools share a name, or one has none, so nothing was sent to Claude."],
    ["schema", "A tool's parameter schema cannot be sent to Claude, so nothing was sent."],
  ] as const)("catalog %s failures have bounded value-free diagnostics", (reason, expected) => {
    const error = new SdkToolContractError({ reason });
    expect(diagnoseSdkRunError(error)).toStrictEqual({
      schemaVersion: 1,
      kind: "tool-contract",
      errorTag: "SdkToolContractError",
      toolContract: reason,
    });
    expect(formatSdkRunError(error)).toBe(expected);
  });

  test("emits structured routing fields without the provider message or cause", () => {
    const error = SdkQueryError.fromCause(
      "iterate",
      new Error("getaddrinfo ENOTFOUND secret.internal.example"),
    );

    const lines: string[] = [];

    writeSdkFailureDiagnostic(error, (line) => {
      lines.push(line);
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"kind":"network","errorTag":"SdkQueryError","operation":"iterate"');
    expect(lines[0]).not.toContain("secret.internal.example");
    expect(lines[0]).not.toContain("ENOTFOUND");
  });

  test("turns a typed authentication failure into an actionable message", () => {
    const error = new SdkResultError({
      terminalReason: undefined,
      category: "provider",
      apiError: "authentication_failed",
    });

    expect(formatSdkRunError(error)).toBe(
      "Claude could not verify your account or cloud credentials. Run `claude auth login` to sign in.",
    );
  });

  test("returns the safe summary without an SDK prefix", () => {
    expect(formatSdkRunError(outOfUsage)).toBe(
      "Claude usage or billing limit reached; `/claude usage` shows your limits.",
    );
    expect(formatSdkRunError(new SdkMissingResultError())).toBe(
      "Claude Code stopped without a final result. Review completed work, then send `continue`.",
    );
    expect(formatSdkRunError(new SdkProviderDefect({ reason: "run-rejected" }))).toBe(
      "pi-claude bug: the Claude runner failed unexpectedly. Report it with `/claude status` output.",
    );
  });

  test.each([
    [new AbortError("aborted"), "The request was cancelled."],
    [
      Object.assign(new Error("spawn claude ENOENT /secret/path"), { code: "ENOENT" }),
      "Claude Code (`claude`) was not found. Install it or set `PI_CLAUDE_PATH`.",
    ],
    [
      sdkRejection("Claude Code process exited with code 2\nstderr: token=abc", {
        errorClass: "process_exited_nonzero",
        exitCode: 2,
      }),
      "Claude Code quit unexpectedly (exit code 2). Run `/claude status` to check it.",
    ],
    [
      sdkRejection("Claude Code process terminated by signal SIGKILL", {
        errorClass: "process_killed_by_signal",
        signal: "SIGKILL",
      }),
      "Claude Code was stopped by signal SIGKILL.",
    ],
    [
      sdkRejection("Claude Code executable not found at /secret/path", {
        errorClass: "executable_not_found",
      }),
      "Claude Code (`claude`) was not found. Install it or set `PI_CLAUDE_PATH`.",
    ],
    [
      sdkRejection("Claude Code native binary exists at /secret but failed to launch", {
        errorClass: "executable_launch_failed",
      }),
      "Claude Code is installed but would not launch. Check `claude` or `PI_CLAUDE_PATH`.",
    ],
    [
      sdkRejection("Claude Code process aborted by user", { errorClass: "aborted" }),
      "The request was cancelled.",
    ],
    [
      new Error("Claude Code process exited with code 2"),
      "Claude Code failed to start with an unexpected error.",
    ],
    [
      sdkRejection("exited", { errorClass: "process_exited_nonzero" }),
      "Claude Code failed to start with an unexpected error.",
    ],
    [
      new Error("proxy https://user:pass@host failed"),
      "Claude Code failed to start with an unexpected error.",
    ],
    ["plain string", "Claude Code failed to start with an unexpected error."],
  ] as const)("classifies a query cause into a safe phrase: %s", (cause, expected) => {
    const error = SdkQueryError.fromCause("start", cause);

    expect(error.message).toBe(expected);
    expect(error.cause).toBe(cause);
  });

  test("keeps working-directory failures actionable, private and non-retryable", () => {
    const error = new SdkQueryError({
      operation: "start",
      reason: SdkQueryFailureReason.cases.WorkingDirectoryUnavailable.make({}),
      cause: new Error("ENOENT /secret/network/timeout/worktree"),
    });

    const message = formatSdkRunError(error);
    expect(message).toContain("Restart Pi from an existing folder");
    expect(message).not.toContain("/secret");
    expect(message).not.toContain("executable not found");
    expect(diagnoseSdkRunError(error)).toStrictEqual({
      schemaVersion: 1,
      kind: "provider",
      errorTag: "SdkQueryError",
      operation: "start",
    });
    expect(
      isRetryableAssistantError({ ...failedAssistant("provider"), errorMessage: message }),
    ).toBe(false);
  });

  test("never renders the raw cause of an iteration failure", () => {
    const error = SdkQueryError.fromCause("iterate", new Error("transport disconnected: secret"));

    expect(formatSdkRunError(error)).toBe("Claude Code stopped mid-turn with an unexpected error.");
  });
});

function failedAssistant(
  category: ConstructorParameters<typeof SdkResultError>[0]["category"],
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "claude",
    provider: "claude",
    model: "claude-5.5-sonnet",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: formatSdkRunError(new SdkResultError({ category, terminalReason: undefined })),
    timestamp: 0,
  };
}

const RETRYABLE_CATEGORIES: ReadonlySet<string> = new Set([
  "rate-limit",
  "overloaded",
  "server-error",
]);

describe("Pi retry compatibility", () => {
  test.each(ResultFailureCategory.literals)("%s keeps its retry and overflow class", (category) => {
    const message = failedAssistant(category);
    expect(isRetryableAssistantError(message)).toBe(RETRYABLE_CATEGORIES.has(category));
    expect(isContextOverflow(message, 200_000)).toBe(category === "context-limit");
  });

  test("an interrupted response stream stays retryable and is not an overflow", () => {
    const message = {
      ...failedAssistant("provider"),
      errorMessage: formatSdkRunError(new SdkStreamInterruptedError({ evidence: "api-retry" })),
    };

    expect(isRetryableAssistantError(message)).toBe(true);
    expect(isContextOverflow(message, 200_000)).toBe(false);
  });
});
