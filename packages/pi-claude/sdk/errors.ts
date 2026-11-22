import { AbortError } from "@anthropic-ai/claude-agent-sdk";
import { Option, Predicate, Schema } from "effect";
import { absurd } from "effect/Function";
import { MIN_CLAUDE_CODE_VERSION } from "./claude-executable";
import { lenientOptional } from "./lenient-schema";
import {
  effectiveResultCategory,
  ResultFailureCategory,
  resultFailureMessage,
} from "./result-failure";

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
    return `Claude Code sent a reply Pi could not read (${this.messageType}: ${this.detail}). Run \`/claude status\` to check versions.`;
  }
}

/** Contract rejection, not malformed data: an extra SDK request cannot be replayed safely. */
export class SdkInternalContinuationError extends Schema.TaggedError<SdkInternalContinuationError>()(
  "SdkInternalContinuationError",
  {},
) {
  override get message(): string {
    return "Claude kept going without Pi, so the turn stopped. Review completed work, then send `continue`.";
  }
}

/** What showed that an attempt's response stream broke after it had started reaching Pi. */
const StreamInterruptionEvidence = Schema.Literals([
  /** Claude Code announced a retry while the attempt had no stop reason. */
  "api-retry",
  /** A new main-loop request started while the previous one had no stop reason. */
  "new-attempt",
  /** The query failed with an untyped API error after its response started. */
  "api-error",
]);

/**
 * The response stream broke after it started. Nothing was handed to Pi, so Pi can discard the
 * partial output and retry the whole turn. The message is worded to match Pi's retry rules.
 */
export class SdkStreamInterruptedError extends Schema.TaggedError<SdkStreamInterruptedError>()(
  "SdkStreamInterruptedError",
  { evidence: StreamInterruptionEvidence },
) {
  override get message(): string {
    return "The response stream was interrupted before Claude finished.";
  }
}

/** Error returned by a terminal SDK result. */
export class SdkResultError extends Schema.TaggedError<SdkResultError>()("SdkResultError", {
  /** The SDK terminal reason when one was supplied. */
  terminalReason: Schema.UndefinedOr(Schema.String),
  /** Safe category derived only from structured SDK fields. */
  category: ResultFailureCategory,
  /** The typed API error an assistant message reported during the turn, if any. */
  apiError: Schema.optional(Schema.String),
}) {
  /** Synthetic bounded summary; no raw SDK text is retained. */
  override get message(): string {
    return resultFailureMessage(effectiveResultCategory(this.category, this.apiError));
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
    return `Claude made ${this.attempts} invalid tool calls, so the turn stopped.`;
  }
}

/** Schema for the safe classification of an SDK query rejection. */
const SdkQueryFailureReason = Schema.TaggedUnion({
  Cancelled: {},
  ExecutableNotFound: {},
  ExecutableLaunchFailed: {},
  ClaudeCodeTooOld: { version: Schema.String },
  WorkingDirectoryUnavailable: {},
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
      return tagged.signal === undefined ||
        !/^SIG(?:ABRT|ALRM|BUS|CHLD|CONT|FPE|HUP|ILL|INT|KILL|PIPE|QUIT|SEGV|STOP|TERM|TRAP|TSTP|TTIN|TTOU|URG|USR1|USR2|VTALRM|WINCH|XCPU|XFSZ)$/u.test(
          tagged.signal,
        )
        ? { _tag: "Unclassified" }
        : { _tag: "ProcessKilled", signal: tagged.signal };
    }
    default: {
      return { _tag: "Unclassified" };
    }
  }
}

function describeQueryFailure(
  reason: SdkQueryFailureReason,
  operation: "start" | "iterate",
): string {
  switch (reason._tag) {
    case "Cancelled": {
      return "The request was cancelled.";
    }
    case "ExecutableNotFound": {
      return "Claude Code (`claude`) was not found. Install it or set `PI_CLAUDE_PATH`.";
    }
    case "ClaudeCodeTooOld": {
      return `Claude Code ${reason.version} is too old; ${MIN_CLAUDE_CODE_VERSION} or newer is required. Run \`claude update\`.`;
    }
    case "ExecutableLaunchFailed": {
      return "Claude Code is installed but would not launch. Check `claude` or `PI_CLAUDE_PATH`.";
    }
    case "WorkingDirectoryUnavailable": {
      return "This session's folder is missing or unreadable. Restart Pi from an existing folder and resume it.";
    }
    case "ProcessExited": {
      return `Claude Code quit unexpectedly (exit code ${reason.exitCode}). Run \`/claude status\` to check it.`;
    }
    case "ProcessKilled": {
      return `Claude Code was stopped by signal ${reason.signal}.`;
    }
    case "Unclassified": {
      return operation === "start"
        ? "Claude Code failed to start with an unexpected error."
        : "Claude Code stopped mid-turn with an unexpected error.";
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
    return describeQueryFailure(this.reason, this.operation);
  }
}

/** Error produced when the SDK query ends without a terminal result message. */
export class SdkMissingResultError extends Schema.TaggedError<SdkMissingResultError>()(
  "SdkMissingResultError",
  {},
) {
  /** Safe summary of the missing result. */
  override get message(): string {
    return "Claude Code stopped without a final result. Review completed work, then send `continue`.";
  }
}

/** Safe callback/setup failure. Callback exceptions and invalid payload values are discarded. */
export class SdkInstrumentationError extends Schema.TaggedError<SdkInstrumentationError>()(
  "SdkInstrumentationError",
  { operation: Schema.Literals(["payload", "replacement", "event", "cancelled"]) },
) {
  /** Static summary that never contains callback or payload data. */
  override get message(): string {
    return this.operation === "replacement"
      ? "An extension returned an invalid request for Claude, so nothing was sent."
      : "An extension that watches requests to Claude failed, so the turn stopped.";
  }
}

export class SdkToolContractError extends Schema.TaggedError<SdkToolContractError>()(
  "SdkToolContractError",
  { reason: Schema.Literals(["naming", "schema"]) },
) {
  override get message(): string {
    return this.reason === "naming"
      ? "Two tools share a name, or one has none, so nothing was sent to Claude."
      : "A tool's parameter schema cannot be sent to Claude, so nothing was sent.";
  }
}

/** Error produced when a turn would be billed to Extra Usage and the user has not opted in. */
export class SdkOverageError extends Schema.TaggedError<SdkOverageError>()("SdkOverageError", {
  /** When the plan limits reopen, in epoch milliseconds, when Claude Code reported it. */
  resetsAt: Schema.UndefinedOr(Schema.Number),
}) {
  /** Actionable summary; contains only a reset time. */
  override get message(): string {
    const until =
      this.resetsAt === undefined
        ? "it resets"
        : `${new Date(this.resetsAt).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    return `Plan limit hit until ${until}; stopped to avoid Extra Usage. To allow it, set \`PI_CLAUDE_ALLOW_EXTRA_USAGE=1\` and restart Pi.`;
  }
}

/** Expected failures that can terminate one provider turn. */
export type SdkRunError =
  | SdkInternalContinuationError
  | SdkStreamInterruptedError
  | SdkInstrumentationError
  | SdkToolContractError
  | InvalidDeferredCallLimitError
  | SdkMissingResultError
  | SdkOverageError
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
      ? "pi-claude bug: the turn finished without a final result. Report it with `/claude status` output."
      : "pi-claude bug: the Claude runner failed unexpectedly. Report it with `/claude status` output.";
  }
}

/** Every failure that can end a Pi turn: expected SDK failures and provider defects. */
export type SdkTurnFailure = SdkRunError | SdkProviderDefect;
