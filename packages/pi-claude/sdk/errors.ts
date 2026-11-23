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

export class InvalidDeferredCallError extends Schema.TaggedError<InvalidDeferredCallError>()(
  "InvalidDeferredCallError",
  {
    requestedName: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class SdkProtocolError extends Schema.TaggedError<SdkProtocolError>()("SdkProtocolError", {
  messageType: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Claude Code sent a reply Pi could not read (${this.messageType}: ${this.detail}). Run \`/claude status\` to check versions.`;
  }
}

export class SdkInternalContinuationError extends Schema.TaggedError<SdkInternalContinuationError>()(
  "SdkInternalContinuationError",
  {},
) {
  override get message(): string {
    return "Claude kept going without Pi, so the turn stopped. Review completed work, then send `continue`.";
  }
}

const StreamInterruptionEvidence = Schema.Literals(["api-retry", "new-attempt", "api-error"]);

export class SdkStreamInterruptedError extends Schema.TaggedError<SdkStreamInterruptedError>()(
  "SdkStreamInterruptedError",
  { evidence: StreamInterruptionEvidence },
) {
  override get message(): string {
    return "The response stream was interrupted before Claude finished.";
  }
}

export class SdkResultError extends Schema.TaggedError<SdkResultError>()("SdkResultError", {
  terminalReason: Schema.UndefinedOr(Schema.String),
  category: ResultFailureCategory,
  apiError: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return resultFailureMessage(effectiveResultCategory(this.category, this.apiError));
  }
}

export class InvalidDeferredCallLimitError extends Schema.TaggedError<InvalidDeferredCallLimitError>()(
  "InvalidDeferredCallLimitError",
  {
    attempts: Schema.Number,
    lastError: InvalidDeferredCallError,
  },
) {
  override get message(): string {
    return `Claude made ${this.attempts} invalid tool calls, so the turn stopped.`;
  }
}

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

type SdkQueryFailureReason = typeof SdkQueryFailureReason.Type;

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

export class SdkQueryError extends Schema.TaggedError<SdkQueryError>()("SdkQueryError", {
  operation: Schema.Literals(["start", "iterate"]),
  reason: SdkQueryFailureReason,
  cause: Schema.Defect(),
}) {
  static fromCause(operation: "start" | "iterate", cause: unknown): SdkQueryError {
    return new SdkQueryError({ operation, reason: classifyQueryCause(cause), cause });
  }

  static cancelled(operation: "start" | "iterate", cause: unknown): SdkQueryError {
    return new SdkQueryError({ operation, reason: { _tag: "Cancelled" }, cause });
  }

  override get message(): string {
    return describeQueryFailure(this.reason, this.operation);
  }
}

export class SdkMissingResultError extends Schema.TaggedError<SdkMissingResultError>()(
  "SdkMissingResultError",
  {},
) {
  override get message(): string {
    return "Claude Code stopped without a final result. Review completed work, then send `continue`.";
  }
}

export class SdkInstrumentationError extends Schema.TaggedError<SdkInstrumentationError>()(
  "SdkInstrumentationError",
  { operation: Schema.Literals(["payload", "replacement", "event", "cancelled"]) },
) {
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

export class SdkOverageError extends Schema.TaggedError<SdkOverageError>()("SdkOverageError", {
  resetsAt: Schema.UndefinedOr(Schema.Number),
}) {
  override get message(): string {
    const until =
      this.resetsAt === undefined
        ? "it resets"
        : `${new Date(this.resetsAt).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    return `Plan limit hit until ${until}; stopped to avoid Extra Usage. To allow it, set \`PI_CLAUDE_ALLOW_EXTRA_USAGE=1\` and restart Pi.`;
  }
}

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

export class SdkProviderDefect extends Schema.TaggedError<SdkProviderDefect>()(
  "SdkProviderDefect",
  {
    reason: Schema.Literals(["no-terminal-event", "run-rejected"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "no-terminal-event"
      ? "pi-claude bug: the turn finished without a final result. Report it with `/claude status` output."
      : "pi-claude bug: the Claude runner failed unexpectedly. Report it with `/claude status` output.";
  }
}

export type SdkTurnFailure = SdkRunError | SdkProviderDefect;
