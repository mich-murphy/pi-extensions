import { AbortError } from "@anthropic-ai/claude-agent-sdk";
import { Option, Predicate, Schema } from "effect";
import { absurd } from "effect/Function";
import { lenientOptional } from "./lenient-schema";

/** Error produced when a deferred Pi tool request is malformed or names an unavailable tool. */
export class InvalidDeferredCallError extends Schema.TaggedError<InvalidDeferredCallError>()(
  "InvalidDeferredCallError",
  {
    /** The requested inner Pi tool name, or an empty string when absent. */
    requestedName: Schema.String,
    /** A safe explanation suitable for the SDK permission response. */
    reason: Schema.String,
  },
) {
  /** The safe explanation returned to the model. */
  override get message(): string {
    return this.reason;
  }
}

/** Error produced when an SDK message does not match the protocol shape used by this provider. */
export class SdkProtocolError extends Schema.TaggedError<SdkProtocolError>()("SdkProtocolError", {
  /** The safe SDK message or event type being parsed. */
  messageType: Schema.String,
  /** A description that does not include prompt or credential data. */
  detail: Schema.String,
}) {
  /** Safe summary of the malformed message. */
  override get message(): string {
    return `sent a malformed ${this.messageType} message (${this.detail})`;
  }
}

/** Error returned by a terminal SDK result. */
export class SdkResultError extends Schema.TaggedError<SdkResultError>()("SdkResultError", {
  /** The SDK terminal reason when one was supplied. */
  terminalReason: Schema.UndefinedOr(Schema.String),
  /** The SDK's safe error summary. */
  detail: Schema.String,
  /** The typed API error an assistant message reported during the turn, if any. */
  apiError: Schema.optional(Schema.String),
}) {
  /** Safe summary: an actionable sentence for a typed authentication failure, else the SDK's. */
  override get message(): string {
    return this.apiError === "authentication_failed"
      ? "Claude Code authentication failed; run `claude` to sign in"
      : this.detail;
  }
}

/** Error produced when the model exceeds the invalid deferred-call retry limit. */
export class InvalidDeferredCallLimitError extends Schema.TaggedError<InvalidDeferredCallLimitError>()(
  "InvalidDeferredCallLimitError",
  {
    /** Number of invalid calls observed during the turn. */
    attempts: Schema.Number,
    /** The final invalid call. */
    lastError: InvalidDeferredCallError,
  },
) {
  /** Safe summary naming the final invalid call. */
  override get message(): string {
    return `Claude exceeded the invalid Pi tool-call limit after ${this.attempts} attempts: ${this.lastError.message}`;
  }
}

/** Schema for the safe classification of an SDK query rejection. */
const SdkQueryFailureReason = Schema.TaggedUnion({
  Cancelled: {},
  ExecutableNotFound: {},
  ExecutableLaunchFailed: {},
  ProcessExited: { exitCode: Schema.Number },
  ProcessKilled: { signal: Schema.String },
  Unclassified: {},
});

/** Safe classification of why an SDK query rejected; the raw cause is never rendered. */
type SdkQueryFailureReason = typeof SdkQueryFailureReason.Type;

// The SDK tags its own rejections with an errorClass, plus the exit code or signal of a dead
// subprocess. Reading these fields keeps classification off the free-form (and secret-bearing)
// message text.
const decodeSdkRejection = Schema.decodeUnknownOption(
  Schema.Struct({
    errorClass: Schema.String,
    exitCode: lenientOptional(Schema.Int),
    signal: lenientOptional(Schema.String),
  }),
);

function classifyQueryCause(cause: unknown): SdkQueryFailureReason {
  if (cause instanceof AbortError || (cause instanceof Error && cause.name === "AbortError")) {
    return { _tag: "Cancelled" };
  }
  // A spawn of a missing binary rejects with Node's ENOENT before the SDK can tag it.
  if (cause instanceof Error && Predicate.hasProperty(cause, "code") && cause.code === "ENOENT") {
    return { _tag: "ExecutableNotFound" };
  }
  const tagged = Option.getOrUndefined(decodeSdkRejection(cause));
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
export class SdkQueryError extends Schema.TaggedError<SdkQueryError>()("SdkQueryError", {
  /** Query phase that failed. */
  operation: Schema.Literals(["start", "iterate"]),
  /** Safe classification of the cause. */
  reason: SdkQueryFailureReason,
  /** Original SDK rejection, retained for local diagnosis only. */
  cause: Schema.Defect(),
}) {
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
export class SdkMissingResultError extends Schema.TaggedError<SdkMissingResultError>()(
  "SdkMissingResultError",
  {},
) {
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
export class SdkProviderDefect extends Schema.TaggedError<SdkProviderDefect>()(
  "SdkProviderDefect",
  {
    /** Which runner contract the bridge observed being broken. */
    reason: Schema.Literals(["no-terminal-event", "run-rejected"]),
    /** The unexpected rejection, retained for local diagnosis only. */
    cause: Schema.optional(Schema.Defect()),
  },
) {
  /** Safe summary of the broken invariant. */
  override get message(): string {
    return this.reason === "no-terminal-event"
      ? "the turn ended without a final result"
      : "the SDK runner failed unexpectedly";
  }
}

/** Every failure that can end a Pi turn: expected SDK failures and provider defects. */
export type SdkTurnFailure = SdkRunError | SdkProviderDefect;
