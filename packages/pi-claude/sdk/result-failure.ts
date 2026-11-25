import { Schema } from "effect";

export const ResultFailureCategory = Schema.Literals([
  "provider",
  "authentication",
  "usage-limit",
  "rate-limit",
  "server-error",
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
  provider: "Claude Code stopped with an error but did not say why.",
  authentication:
    "Claude could not verify your account or cloud credentials. Run `claude auth login` to sign in.",
  "usage-limit": "Claude usage or billing limit reached; `/claude usage` shows your limits.",
  "rate-limit": "Claude hit a rate limit: too many requests in a short time.",
  "server-error": "Lost the connection to Claude, or Claude had a server error.",
  refusal: "Claude declined to answer this request.",
  "tool-contract": "Claude's tool call could not be passed back to Pi, so it did not run.",
  cancelled: "The request was cancelled before Claude finished.",
  "context-limit": "Claude's context window is full (prompt is too long).",
  request: "Claude rejected the request: the model or part of the input is not supported.",
  overloaded: "Claude is overloaded right now.",
  "turn-limit":
    "Claude reached its turn limit and stopped partway. Review completed work, then send `continue`.",
  "budget-limit": "Claude reached its budget limit and stopped.",
  "output-limit": "Claude's reply hit the output limit. Ask for a shorter answer.",
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
  ["rate_limit", "rate-limit"],
  ["overloaded", "overloaded"],
  ["invalid_request", "request"],
  ["model_not_found", "request"],
  ["server_error", "server-error"],
  ["unknown", "provider"],
  ["max_output_tokens", "output-limit"],
  ["cloud_credential_error", "authentication"],
]);

const SUBTYPE_CATEGORIES: ReadonlyMap<string, typeof ResultFailureCategory.Type> = new Map([
  ["error_max_turns", "turn-limit"],
  ["error_max_budget_usd", "budget-limit"],
  ["error_max_structured_output_retries", "output-limit"],
]);

export function safeTerminalReason(reason: string): string;
export function safeTerminalReason(reason: string | undefined): string | undefined;
export function safeTerminalReason(reason: string | undefined): string | undefined {
  return reason === undefined || TERMINAL_REASONS.has(reason) ? reason : "unrecognized";
}

export function safeApiError(error: string | undefined): string | undefined {
  return error !== undefined && API_CATEGORIES.has(error) ? error : undefined;
}

export function resultFailureCategory(
  reason: string | undefined,
  subtype: string | undefined,
): typeof ResultFailureCategory.Type {
  return (
    TERMINAL_CATEGORIES.get(reason ?? "") ?? SUBTYPE_CATEGORIES.get(subtype ?? "") ?? "provider"
  );
}

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

export function resultFailureMessage(category: typeof ResultFailureCategory.Type): string {
  return MESSAGES[category];
}
