import { AbortError } from "@anthropic-ai/claude-agent-sdk";
import { Data, Predicate } from "effect";
import { absurd } from "effect/Function";
import { z } from "zod";

/** Error produced when a deferred Pi tool request is malformed or names an unavailable tool. */
export class InvalidDeferredCallError extends Data.TaggedError("InvalidDeferredCallError")<{
  /** The requested inner Pi tool name, or an empty string when absent. */
  readonly requestedName: string;
  /** A safe explanation suitable for the SDK permission response. */
  readonly reason: string;
}> {
  /** The safe explanation returned to the model. */
  override get message(): string {
    return this.reason;
  }
}

/** Error produced when an SDK message does not match the protocol shape used by this provider. */
export class SdkProtocolError extends Data.TaggedError("SdkProtocolError")<{
  /** The safe SDK message or event type being parsed. */
  readonly messageType: string;
  /** A description that does not include prompt or credential data. */
  readonly detail: string;
}> {
  /** Safe summary of the malformed message. */
  override get message(): string {
    return `sent a malformed ${this.messageType} message (${this.detail})`;
  }
}

/** Error returned by a terminal SDK result. */
export class SdkResultError extends Data.TaggedError("SdkResultError")<{
  /** The SDK terminal reason when one was supplied. */
  readonly terminalReason: string | undefined;
  /** The SDK's safe error summary. */
  readonly detail: string;
  /** The typed API error an assistant message reported during the turn, if any. */
  readonly apiError?: string | undefined;
}> {
  /** Safe summary: an actionable sentence for a typed authentication failure, else the SDK's. */
  override get message(): string {
    return this.apiError === "authentication_failed"
      ? "Claude Code authentication failed; run `claude` to sign in"
      : this.detail;
  }
}

/** Error produced when the model exceeds the invalid deferred-call retry limit. */
export class InvalidDeferredCallLimitError extends Data.TaggedError(
  "InvalidDeferredCallLimitError",
)<{
  /** Number of invalid calls observed during the turn. */
  readonly attempts: number;
  /** The final invalid call. */
  readonly lastError: InvalidDeferredCallError;
}> {
  /** Safe summary naming the final invalid call. */
  override get message(): string {
    return `Claude exceeded the invalid Pi tool-call limit after ${this.attempts} attempts: ${this.lastError.message}`;
  }
}

/** Safe classification of why an SDK query rejected; the raw cause is never rendered. */
export type SdkQueryFailureReason =
  | { readonly _tag: "Cancelled" }
  | { readonly _tag: "ExecutableNotFound" }
  | { readonly _tag: "ExecutableLaunchFailed" }
  | { readonly _tag: "ProcessExited"; readonly exitCode: number }
  | { readonly _tag: "ProcessKilled"; readonly signal: string }
  | { readonly _tag: "Unclassified" };

// The SDK tags its own rejections with an errorClass, plus the exit code or signal of a dead
// subprocess. Reading these fields keeps classification off the free-form (and secret-bearing)
// message text.
const sdkRejectionSchema = z.object({
  errorClass: z.string(),
  exitCode: z.number().int().optional().catch(undefined),
  signal: z.string().optional().catch(undefined),
});

function classifyQueryCause(cause: unknown): SdkQueryFailureReason {
  if (cause instanceof AbortError || (cause instanceof Error && cause.name === "AbortError")) {
    return { _tag: "Cancelled" };
  }
  // A spawn of a missing binary rejects with Node's ENOENT before the SDK can tag it.
  if (cause instanceof Error && Predicate.hasProperty(cause, "code") && cause.code === "ENOENT") {
    return { _tag: "ExecutableNotFound" };
  }
  const tagged = sdkRejectionSchema.safeParse(cause).data;
  if (tagged === undefined) {
    return { _tag: "Unclassified" };
  }
  switch (tagged.errorClass) {
    case "aborted": {
      return { _tag: "Cancelled" };
    }
    case "executable_not_found": {
      return { _tag: "ExecutableNotFound" };
    }
    case "executable_launch_failed": {
      return { _tag: "ExecutableLaunchFailed" };
    }
    case "process_exited_nonzero": {
      return tagged.exitCode === undefined
        ? { _tag: "Unclassified" }
        : { _tag: "ProcessExited", exitCode: tagged.exitCode };
    }
    case "process_killed_by_signal": {
      return tagged.signal === undefined
        ? { _tag: "Unclassified" }
        : { _tag: "ProcessKilled", signal: tagged.signal };
    }
    default: {
      return { _tag: "Unclassified" };
    }
  }
}

function describeQueryFailure(reason: SdkQueryFailureReason): string {
  switch (reason._tag) {
    case "Cancelled": {
      return "cancelled";
    }
    case "ExecutableNotFound": {
      return "Claude Code executable not found";
    }
    case "ExecutableLaunchFailed": {
      return "Claude Code is installed but could not be launched";
    }
    case "ProcessExited": {
      return `Claude Code exited with code ${reason.exitCode}`;
    }
    case "ProcessKilled": {
      return `Claude Code was terminated by ${reason.signal}`;
    }
    case "Unclassified": {
      return "unexpected SDK error";
    }
    default: {
      return absurd(reason);
    }
  }
}

/** Error produced when the SDK query cannot start or rejects while streaming. */
export class SdkQueryError extends Data.TaggedError("SdkQueryError")<{
  /** Query phase that failed. */
  readonly operation: "start" | "iterate";
  /** Safe classification of the cause. */
  readonly reason: SdkQueryFailureReason;
  /** Original SDK rejection, retained for local diagnosis only. */
  readonly cause: unknown;
}> {
  /**
   * Classify an SDK rejection.
   *
   * @param operation - Query phase that failed.
   * @param cause - Original SDK rejection.
   * @returns A query error whose message names only the classified reason.
   */
  static fromCause(operation: "start" | "iterate", cause: unknown): SdkQueryError {
    return new SdkQueryError({ operation, reason: classifyQueryCause(cause), cause });
  }

  /**
   * Record a query that Pi or the runner cancelled, whatever the SDK rejected with.
   *
   * @param operation - Query phase that was cancelled.
   * @param cause - Abort reason or SDK rejection.
   * @returns A query error classified as cancelled.
   */
  static cancelled(operation: "start" | "iterate", cause: unknown): SdkQueryError {
    return new SdkQueryError({ operation, reason: { _tag: "Cancelled" }, cause });
  }

  /** Safe summary naming the phase and classified reason. */
  override get message(): string {
    const reason = describeQueryFailure(this.reason);
    return this.operation === "start"
      ? `could not start the query (${reason})`
      : `the query stopped before finishing (${reason})`;
  }
}

/** Error produced when the SDK query ends without a terminal result message. */
export class SdkMissingResultError extends Data.TaggedError("SdkMissingResultError") {
  /** Safe summary of the missing result. */
  override get message(): string {
    return "the query ended without returning a result";
  }
}

/** Expected failures that can terminate one provider turn. */
export type SdkRunError =
  | InvalidDeferredCallLimitError
  | SdkMissingResultError
  | SdkProtocolError
  | SdkQueryError
  | SdkResultError;

/**
 * A broken provider invariant caught at the Pi stream boundary. Pi's stream must still end,
 * so the defect is reported as a failed turn rather than thrown.
 */
export class SdkProviderDefect extends Data.TaggedError("SdkProviderDefect")<{
  /** Which runner contract the bridge observed being broken. */
  readonly reason: "no-terminal-event" | "run-rejected";
  /** The unexpected rejection, retained for local diagnosis only. */
  readonly cause?: unknown;
}> {
  /** Safe summary of the broken invariant. */
  override get message(): string {
    return this.reason === "no-terminal-event"
      ? "the turn ended without a final result"
      : "the SDK runner failed unexpectedly";
  }
}

/** Every failure that can end a Pi turn: expected SDK failures and provider defects. */
export type SdkTurnFailure = SdkRunError | SdkProviderDefect;
