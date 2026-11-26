import { Match, Predicate } from "effect";
import { writeRedirectedDiagnostic } from "../diagnostic-output";
import type {
  SdkQueryError,
  SdkResultError,
  SdkStreamInterruptedError,
  SdkTurnFailure,
} from "./errors";
import { effectiveResultCategory, safeTerminalReason } from "./result-failure";

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

export type SdkFailureDiagnostic = {
  readonly schemaVersion: 1;
  readonly kind: SdkFailureKind;
  readonly errorTag: SdkTurnFailure["_tag"];
  readonly operation?: SdkQueryError["operation"];
  readonly terminalReason?: string;
  readonly toolContract?: "naming" | "schema";
  readonly streamInterruption?: SdkStreamInterruptedError["evidence"];
};

const TEXT_KINDS: ReadonlyArray<readonly [kind: SdkFailureKind, pattern: RegExp]> = [
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
  if (Predicate.isTagged("WorkingDirectoryUnavailable")(reason)) {
    return "provider";
  }

  return Predicate.isTagged("Cancelled")(reason)
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

const failureKind = Match.type<SdkTurnFailure>().pipe(
  Match.withReturnType<SdkFailureKind>(),
  Match.tagsExhaustive({
    SdkInstrumentationError: () => "provider",
    SdkProviderDefect: () => "defect",
    SdkInternalContinuationError: () => "internal-continuation",
    SdkStreamInterruptedError: () => "stream-interrupted",
    SdkProtocolError: () => "protocol",
    SdkToolContractError: () => "tool-contract",
    InvalidDeferredCallLimitError: () => "tool-contract",
    SdkQueryError: queryFailureKind,
    SdkResultError: resultFailureKind,
    SdkOverageError: () => "usage-limit",
    SdkMissingResultError: () => "provider",
  }),
);

type FailureDiagnostic = {
  -readonly [Key in keyof SdkFailureDiagnostic]: SdkFailureDiagnostic[Key];
};

export function diagnoseSdkRunError(error: SdkTurnFailure): SdkFailureDiagnostic {
  const diagnostic: FailureDiagnostic = {
    schemaVersion: 1,
    kind: failureKind(error),
    errorTag: error._tag,
  };

  if (Predicate.isTagged("SdkToolContractError")(error)) {
    diagnostic.toolContract = error.reason;
  }

  if (Predicate.isTagged("SdkQueryError")(error)) {
    diagnostic.operation = error.operation;
  }

  if (Predicate.isTagged("SdkStreamInterruptedError")(error)) {
    diagnostic.streamInterruption = error.evidence;
  }

  if (Predicate.isTagged("SdkResultError")(error) && error.terminalReason !== undefined) {
    diagnostic.terminalReason = safeTerminalReason(error.terminalReason);
  }

  return diagnostic;
}

export function formatSdkRunError(error: SdkTurnFailure): string {
  return error.message;
}

export function writeSdkFailureDiagnostic(
  error: SdkTurnFailure,
  write: (line: string) => void = writeRedirectedDiagnostic,
): void {
  write(`[claude-error] ${JSON.stringify(diagnoseSdkRunError(error))}\n`);
}
