import { AbortError } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { describe, expect, test } from "vitest";
import {
  InvalidDeferredCallError,
  InvalidDeferredCallLimitError,
  SdkMissingResultError,
  SdkProtocolError,
  SdkProviderDefect,
  SdkQueryError,
  SdkResultError,
  SdkToolContractError,
} from "../sdk/errors";
import {
  diagnoseSdkRunError,
  formatSdkRunError,
  writeSdkFailureDiagnostic,
} from "../sdk/failure-diagnostics";

function sdkRejection(message: string, fields: Readonly<Record<string, unknown>>): Error {
  return Object.assign(new Error(message), fields);
}

const outOfUsage = new SdkResultError({
  terminalReason: undefined,
  category: "usage-limit",
});

describe("claude SDK failure diagnostics", () => {
  test.each([
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

  test.each(["naming", "schema"] as const)(
    "catalog %s failures have bounded value-free diagnostics",
    (reason) => {
      const error = new SdkToolContractError({ reason });
      expect(diagnoseSdkRunError(error)).toStrictEqual({
        schemaVersion: 1,
        kind: "tool-contract",
        errorTag: "SdkToolContractError",
        toolContract: reason,
      });
      expect(formatSdkRunError(error)).toBe(
        `Claude Agent SDK: Pi tool catalog cannot be advertised faithfully (${reason})`,
      );
    },
  );

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
      "Claude Agent SDK: Claude Code authentication failed; run `claude` to sign in",
    );
  });

  test("prefixes the SDK name once onto the safe summary", () => {
    expect(formatSdkRunError(outOfUsage)).toBe(
      "Claude Agent SDK: Claude usage limit reached; check subscription allowance",
    );
    expect(formatSdkRunError(new SdkMissingResultError())).toBe(
      "Claude Agent SDK: the query ended without returning a result",
    );
    expect(formatSdkRunError(new SdkProviderDefect({ reason: "run-rejected" }))).toBe(
      "Claude SDK provider bug: the SDK runner failed unexpectedly",
    );
  });

  test.each([
    [new AbortError("aborted"), "could not start the query (cancelled)"],
    [
      Object.assign(new Error("spawn claude ENOENT /secret/path"), { code: "ENOENT" }),
      "could not start the query (Claude Code executable not found)",
    ],
    [
      sdkRejection("Claude Code process exited with code 2\nstderr: token=abc", {
        errorClass: "process_exited_nonzero",
        exitCode: 2,
      }),
      "could not start the query (Claude Code exited with code 2)",
    ],
    [
      sdkRejection("Claude Code process terminated by signal SIGKILL", {
        errorClass: "process_killed_by_signal",
        signal: "SIGKILL",
      }),
      "could not start the query (Claude Code was terminated by SIGKILL)",
    ],
    [
      sdkRejection("Claude Code executable not found at /secret/path", {
        errorClass: "executable_not_found",
      }),
      "could not start the query (Claude Code executable not found)",
    ],
    [
      sdkRejection("Claude Code native binary exists at /secret but failed to launch", {
        errorClass: "executable_launch_failed",
      }),
      "could not start the query (Claude Code is installed but could not be launched)",
    ],
    [
      sdkRejection("Claude Code process aborted by user", { errorClass: "aborted" }),
      "could not start the query (cancelled)",
    ],
    [
      new Error("Claude Code process exited with code 2"),
      "could not start the query (unexpected SDK error)",
    ],
    [
      sdkRejection("exited", { errorClass: "process_exited_nonzero" }),
      "could not start the query (unexpected SDK error)",
    ],
    [
      new Error("proxy https://user:pass@host failed"),
      "could not start the query (unexpected SDK error)",
    ],
    ["plain string", "could not start the query (unexpected SDK error)"],
  ] as const)("classifies a query cause into a safe phrase: %s", (cause, expected) => {
    const error = SdkQueryError.fromCause("start", cause);

    expect(error.message).toBe(expected);
    expect(error.cause).toBe(cause);
  });

  test("never renders the raw cause of an iteration failure", () => {
    const error = SdkQueryError.fromCause("iterate", new Error("transport disconnected: secret"));

    expect(formatSdkRunError(error)).toBe(
      "Claude Agent SDK: the query stopped before finishing (unexpected SDK error)",
    );
  });
});

/** A failed Pi assistant message carrying the bridge's formatted text for one category. */
function failedAssistant(
  category: ConstructorParameters<typeof SdkResultError>[0]["category"],
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "claude-sdk",
    provider: "claude-sdk",
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

describe("Pi retry compatibility", () => {
  test.each(["rate-limit", "overloaded", "server-error"] as const)(
    "%s is retryable",
    (category) => {
      expect(isRetryableAssistantError(failedAssistant(category))).toBe(true);
    },
  );

  test.each(["usage-limit", "authentication", "context-limit"] as const)(
    "%s is not retryable",
    (category) => {
      expect(isRetryableAssistantError(failedAssistant(category))).toBe(false);
    },
  );

  test("context-limit still reads as context overflow", () => {
    expect(isContextOverflow(failedAssistant("context-limit"))).toBe(true);
  });
});
