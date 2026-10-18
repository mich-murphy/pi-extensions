import { Schema } from "effect";

/** Bounded result categories; free-form SDK errors/result text is never retained. */
export const ResultFailureCategory = Schema.Literals([
  "provider",
  "authentication",
  "usage-limit",
  "refusal",
  "tool-contract",
  "cancelled",
  "context-limit",
  "request",
  "overloaded",
  "turn-limit",
  "budget-limit",
  "output-limit",
]);

const MESSAGES: Readonly<Record<typeof ResultFailureCategory.Type, string>> = {
  provider: "the query failed; retry or check Claude Code status",
  authentication: "Claude Code authentication failed; run `claude` to sign in",
  "usage-limit": "Claude usage limit reached; check subscription allowance",
  refusal: "the model refused to complete the request",
  "tool-contract": "could not hand the requested Pi tool call back to Pi",
  cancelled: "the query was cancelled",
  "context-limit": "context_length_exceeded: shorten the conversation",
  request: "Claude rejected the request; check model and input support",
  overloaded: "Claude is temporarily overloaded; retry later",
  "turn-limit": "the SDK turn limit was reached",
  "budget-limit": "the SDK budget limit was reached",
  "output-limit": "the SDK output limit was reached",
};

const TERMINAL_CATEGORIES: ReadonlyMap<string, typeof ResultFailureCategory.Type> = new Map([
  ["blocking_limit", "usage-limit"],
  ["rapid_refill_breaker", "usage-limit"],
  ["prompt_too_long", "context-limit"],
  ["image_error", "request"],
  ["aborted_streaming", "cancelled"],
  ["aborted_tools", "cancelled"],
  ["malformed_tool_use_exhausted", "tool-contract"],
  ["tool_deferred_unavailable", "tool-contract"],
  ["max_turns", "turn-limit"],
  ["budget_exhausted", "budget-limit"],
  ["structured_output_retry_exhausted", "output-limit"],
]);
const TERMINAL_REASONS = new Set([
  ...TERMINAL_CATEGORIES.keys(),
  "model_error",
  "api_error",
  "stop_hook_prevented",
  "hook_stopped",
  "tool_deferred",
  "background_requested",
  "completed",
  "turn_setup_failed",
]);
const API_CATEGORIES: ReadonlyMap<string, typeof ResultFailureCategory.Type> = new Map([
  ["authentication_failed", "authentication"],
  ["oauth_org_not_allowed", "authentication"],
  ["account_on_hold", "authentication"],
  ["verification_required", "authentication"],
  ["billing_error", "usage-limit"],
  ["rate_limit", "usage-limit"],
  ["overloaded", "overloaded"],
  ["invalid_request", "request"],
  ["model_not_found", "request"],
  ["server_error", "provider"],
  ["unknown", "provider"],
  ["max_output_tokens", "output-limit"],
  ["cloud_credential_error", "authentication"],
]);
const SUBTYPE_CATEGORIES: ReadonlyMap<string, typeof ResultFailureCategory.Type> = new Map([
  ["error_max_turns", "turn-limit"],
  ["error_max_budget_usd", "budget-limit"],
  ["error_max_structured_output_retries", "output-limit"],
]);

/** Keep known vocabulary and mark unknown reasons without echoing their value. */
export function safeTerminalReason(reason: string): string;
export function safeTerminalReason(reason: string | undefined): string | undefined;
export function safeTerminalReason(reason: string | undefined): string | undefined {
  return reason === undefined || TERMINAL_REASONS.has(reason) ? reason : "unrecognized";
}

/** Retain only typed API error vocabulary. */
export function safeApiError(error: string | undefined): string | undefined {
  return error !== undefined && API_CATEGORIES.has(error) ? error : undefined;
}

/** Classify only structured terminal fields, never errors/result text. */
export function resultFailureCategory(
  reason: string | undefined,
  subtype: string | undefined,
): typeof ResultFailureCategory.Type {
  return (
    TERMINAL_CATEGORIES.get(reason ?? "") ?? SUBTYPE_CATEGORIES.get(subtype ?? "") ?? "provider"
  );
}

/** Authentication wins; otherwise an explicit terminal category outranks earlier API errors. */
export function effectiveResultCategory(
  category: typeof ResultFailureCategory.Type,
  apiError: string | undefined,
): typeof ResultFailureCategory.Type {
  const apiCategory = API_CATEGORIES.get(apiError ?? "");
  if (apiCategory === "authentication" || category === "provider") {
    return apiCategory ?? category;
  }
  return category;
}

/** Synthetic actionable summary with no upstream free-form text. */
export function resultFailureMessage(category: typeof ResultFailureCategory.Type): string {
  return MESSAGES[category];
}
