import { absurd } from "effect/Function";
import { writeRedirectedDiagnostic } from "../diagnostic-output";
import type {
  SdkQueryError,
  SdkResultError,
  SdkStreamInterruptedError,
  SdkTurnFailure,
} from "./errors";
import { effectiveResultCategory, safeTerminalReason } from "./result-failure";

/** Stable operational categories for Claude Agent SDK failures. */
export type SdkFailureKind =
  | "authentication"
  | "cancelled"
  | "defect"
  | "internal-continuation"
  | "host-sleep"
  | "network"
  | "protocol"
  | "provider"
  | "rate-limit"
  | "server-error"
  | "stream-interrupted"
  | "timeout"
  | "tool-contract"
  | "usage-limit";

/** Safe structured diagnostic emitted for a failed provider turn. */
export type SdkFailureDiagnostic = {
  /** Stable event schema version. */
  readonly schemaVersion: 1;
  /** Failure category used for routing and support. */
  readonly kind: SdkFailureKind;
  /** Tagged extension error type. */
  readonly errorTag: SdkTurnFailure["_tag"];
  /** Query operation when the SDK transport failed. */
  readonly operation?: SdkQueryError["operation"];
  /** SDK terminal reason when a result supplied one. */
  readonly terminalReason?: string;
  readonly toolContract?: "naming" | "schema";
  /** What showed that a started response stream broke. */
  readonly streamInterruption?: SdkStreamInterruptedError["evidence"];
};

const TEXT_KINDS: readonly (readonly [kind: SdkFailureKind, pattern: RegExp])[] = [
  [
    "usage-limit",
    /(?:credits_required|extra usage|individual spend limit|out of (?:extra )?usage|usage limit)/iu,
  ],
  ["host-sleep", /(?:computer|host|machine).{0,40}(?:went to sleep|slept|sleep mid-response)/iu],
  ["timeout", /(?:deadline exceeded|request timed out|timed out|timeout)/iu],
  [
    "network",
    /(?:can't reach the API server|dns|econnrefused|econnreset|enotfound|network|fetch failed|socket hang up)/iu,
  ],
  ["cancelled", /(?:abort|cancelled|canceled|interrupted)/iu],
];

function textKind(text: string): SdkFailureKind {
  return TEXT_KINDS.find(([, pattern]) => pattern.test(text))?.[0] ?? "provider";
}

function queryFailureKind({ cause, reason }: SdkQueryError): SdkFailureKind {
  if (reason._tag === "WorkingDirectoryUnavailable") {
    return "provider";
  }
  return reason._tag === "Cancelled"
    ? "cancelled"
    : textKind(cause instanceof Error ? cause.message : String(cause));
}

type ResultKind =
  | "authentication"
  | "usage-limit"
  | "rate-limit"
  | "server-error"
  | "cancelled"
  | "tool-contract";

const RESULT_KINDS: ReadonlySet<string> = new Set<ResultKind>([
  "authentication",
  "usage-limit",
  "rate-limit",
  "server-error",
  "cancelled",
  "tool-contract",
]);

function isResultKind(category: string): category is ResultKind {
  return RESULT_KINDS.has(category);
}

function resultFailureKind(error: SdkResultError): SdkFailureKind {
  const category = effectiveResultCategory(error.category, error.apiError);
  return isResultKind(category) ? category : "provider";
}

function failureKind(error: SdkTurnFailure): SdkFailureKind {
  switch (error._tag) {
    case "SdkInstrumentationError": {
      return "provider";
    }
    case "SdkProviderDefect": {
      return "defect";
    }
    case "SdkInternalContinuationError": {
      return "internal-continuation";
    }
    case "SdkStreamInterruptedError": {
      return "stream-interrupted";
    }
    case "SdkProtocolError": {
      return "protocol";
    }
    case "SdkToolContractError":
    case "InvalidDeferredCallLimitError": {
      return "tool-contract";
    }
    case "SdkQueryError": {
      return queryFailureKind(error);
    }
    case "SdkResultError": {
      return resultFailureKind(error);
    }
    case "SdkOverageError": {
      return "usage-limit";
    }
    case "SdkMissingResultError": {
      return "provider";
    }
    default: {
      return absurd(error);
    }
  }
}

/** Classify a typed SDK failure without exposing its message or cause. */
export function diagnoseSdkRunError(error: SdkTurnFailure): SdkFailureDiagnostic {
  return {
    schemaVersion: 1,
    kind: failureKind(error),
    errorTag: error._tag,
    ...(error._tag === "SdkToolContractError" ? { toolContract: error.reason } : {}),
    ...(error._tag === "SdkQueryError" ? { operation: error.operation } : {}),
    ...(error._tag === "SdkStreamInterruptedError" ? { streamInterruption: error.evidence } : {}),
    ...(error._tag === "SdkResultError" && error.terminalReason !== undefined
      ? { terminalReason: safeTerminalReason(error.terminalReason) }
      : {}),
  };
}

/** Format a failed turn's safe summary for Pi's error message. */
export function formatSdkRunError(error: SdkTurnFailure): string {
  return error.message;
}

/** Emit one message-free JSON diagnostic; the default sink skips terminal stderr. */
export function writeSdkFailureDiagnostic(
  error: SdkTurnFailure,
  write: (line: string) => void = writeRedirectedDiagnostic,
): void {
  write(`[claude-error] ${JSON.stringify(diagnoseSdkRunError(error))}\n`);
}
