import { absurd } from "effect/Function";
import type { SdkQueryError, SdkTurnFailure } from "./errors";

/** Stable operational categories for Claude Agent SDK failures. */
export type SdkFailureKind =
  | "authentication"
  | "cancelled"
  | "defect"
  | "host-sleep"
  | "network"
  | "protocol"
  | "provider"
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
};

// Failure text matches in this order, so the first matching pattern names the kind.
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

function failureKind(error: SdkTurnFailure): SdkFailureKind {
  switch (error._tag) {
    case "SdkProviderDefect": {
      return "defect";
    }
    case "SdkProtocolError": {
      return "protocol";
    }
    case "InvalidDeferredCallLimitError": {
      return "tool-contract";
    }
    case "SdkQueryError": {
      // The raw cause is matched here only; it never reaches the diagnostic or the user.
      const { cause, reason } = error;
      return reason._tag === "Cancelled"
        ? "cancelled"
        : textKind(cause instanceof Error ? cause.message : String(cause));
    }
    case "SdkResultError": {
      return error.apiError === "authentication_failed"
        ? "authentication"
        : textKind(error.message);
    }
    case "SdkMissingResultError": {
      return textKind(error.message);
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
    ...(error._tag === "SdkQueryError" ? { operation: error.operation } : {}),
    ...(error._tag === "SdkResultError" && error.terminalReason !== undefined
      ? { terminalReason: error.terminalReason }
      : {}),
  };
}

/** Format a failed turn's safe summary for Pi's error message. */
export function formatSdkRunError(error: SdkTurnFailure): string {
  return error._tag === "SdkProviderDefect"
    ? `Claude SDK provider bug: ${error.message}`
    : `Claude Agent SDK: ${error.message}`;
}

/** Emit one message-free JSON diagnostic for operational routing. */
export function writeSdkFailureDiagnostic(
  error: SdkTurnFailure,
  write: (line: string) => void = (line) => process.stderr.write(line),
): void {
  write(`[claude-sdk-error] ${JSON.stringify(diagnoseSdkRunError(error))}\n`);
}
