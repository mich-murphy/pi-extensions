import {
  InvalidDeferredCallLimitError,
  SdkProtocolError,
  SdkQueryError,
  SdkResultError,
  type SdkRunError,
} from "./errors";

/** Stable operational categories for Claude Agent SDK failures. */
export type SdkFailureKind =
  | "cancelled"
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
  readonly errorTag: SdkRunError["_tag"];
  /** Query operation when the SDK transport failed. */
  readonly operation?: SdkQueryError["operation"];
  /** SDK terminal reason when a result supplied one. */
  readonly terminalReason?: string;
};

const USAGE_LIMIT =
  /(?:credits_required|extra usage|individual spend limit|out of (?:extra )?usage|usage limit)/i;
const HOST_SLEEP = /(?:computer|host|machine).{0,40}(?:went to sleep|slept|sleep mid-response)/i;
const TIMEOUT = /(?:deadline exceeded|request timed out|timed out|timeout)/i;
const NETWORK =
  /(?:can't reach the API server|dns|econnrefused|econnreset|enotfound|network|fetch failed|socket hang up)/i;
const CANCELLED = /(?:abort|cancelled|canceled|interrupted)/i;

function safeFailureText(error: SdkRunError): string {
  if (error instanceof SdkQueryError) {
    return error.cause instanceof Error ? error.cause.message : String(error.cause);
  }
  return error.message;
}

/** Classify a typed SDK failure without exposing its message or cause. */
export function diagnoseSdkRunError(error: SdkRunError): SdkFailureDiagnostic {
  const text = safeFailureText(error);
  let kind: SdkFailureKind;
  if (error instanceof SdkProtocolError) kind = "protocol";
  else if (error instanceof InvalidDeferredCallLimitError) kind = "tool-contract";
  else if (USAGE_LIMIT.test(text)) kind = "usage-limit";
  else if (HOST_SLEEP.test(text)) kind = "host-sleep";
  else if (TIMEOUT.test(text)) kind = "timeout";
  else if (NETWORK.test(text)) kind = "network";
  else if (CANCELLED.test(text)) kind = "cancelled";
  else kind = "provider";

  return {
    schemaVersion: 1,
    kind,
    errorTag: error._tag,
    ...(error instanceof SdkQueryError ? { operation: error.operation } : {}),
    ...(error instanceof SdkResultError && error.terminalReason !== undefined
      ? { terminalReason: error.terminalReason }
      : {}),
  };
}

/** Format a failed turn with a stable category and its safe existing summary. */
export function formatSdkRunError(error: SdkRunError): string {
  return `Claude SDK [${diagnoseSdkRunError(error).kind}]: ${error.message}`;
}

/** Emit one message-free JSON diagnostic for operational routing. */
export function writeSdkFailureDiagnostic(
  error: SdkRunError,
  write: (line: string) => void = (line) => process.stderr.write(line),
): void {
  write(`[claude-sdk-error] ${JSON.stringify(diagnoseSdkRunError(error))}\n`);
}
