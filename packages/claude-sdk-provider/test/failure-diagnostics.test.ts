import { AbortError } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test } from "vitest";
import {
  InvalidDeferredCallError,
  InvalidDeferredCallLimitError,
  SdkMissingResultError,
  SdkProtocolError,
  SdkProviderDefect,
  SdkQueryError,
  SdkResultError,
} from "../sdk/errors";
import {
  diagnoseSdkRunError,
  formatSdkRunError,
  writeSdkFailureDiagnostic,
} from "../sdk/failure-diagnostics";

/** An SDK rejection carrying the structured fields the SDK attaches to its own errors. */
function sdkRejection(message: string, fields: Readonly<Record<string, unknown>>): Error {
  return Object.assign(new Error(message), fields);
}

const outOfUsage = new SdkResultError({
  terminalReason: undefined,
  detail: "You're out of extra usage",
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
      new SdkResultError({
        terminalReason: undefined,
        detail: "Your computer went to sleep mid-response",
      }),
      "host-sleep",
    ],
    [SdkQueryError.fromCause("iterate", new Error("This operation was aborted")), "cancelled"],
    [SdkQueryError.cancelled("start", "stop"), "cancelled"],
    [
      new SdkResultError({ terminalReason: "model_error", detail: "upstream model error" }),
      "provider",
    ],
    [new SdkMissingResultError(), "provider"],
    [new SdkProviderDefect({ reason: "no-terminal-event" }), "defect"],
    [
      new SdkResultError({
        terminalReason: undefined,
        detail: "Invalid API key · Please run /login",
        apiError: "authentication_failed",
      }),
      "authentication",
    ],
  ] as const)("classifies %s as %s", (error, expectedKind) => {
    expect(diagnoseSdkRunError(error).kind).toBe(expectedKind);
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
      detail: "Invalid API key · Please run /login",
      apiError: "authentication_failed",
    });
    expect(formatSdkRunError(error)).toBe(
      "Claude Agent SDK: Claude Code authentication failed; run `claude` to sign in",
    );
  });

  test("prefixes the SDK name once onto the safe summary", () => {
    expect(formatSdkRunError(outOfUsage)).toBe("Claude Agent SDK: You're out of extra usage");
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
      // Message text alone is never trusted: without the SDK's errorClass this stays unclassified.
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
