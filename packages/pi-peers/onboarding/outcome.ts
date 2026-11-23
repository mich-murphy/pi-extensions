import type { Outcome } from "./menu/progress.js";
import { Refusal } from "./refusal.js";

const SAFE_REASON = /^[\p{L}\p{N} .,;:()'’—–-]{1,240}$/u;
export function safeReason(error: unknown, fallback = ""): string {
  if (
    error instanceof Error &&
    Object.getPrototypeOf(error) === Error.prototype &&
    !("code" in error) &&
    SAFE_REASON.test(error.message)
  ) {
    return error.message.replace(/\.$/u, "");
  }
  return fallback;
}

const UNEXPECTED = "unexpected error";

export function failed(
  what: string,
  reason: string,
  next: string,
  technical: readonly string[] = [],
): Outcome {
  return { ok: false, headline: `✗ ${what}: ${reason}`, facts: [], next, technical };
}

export function failedWith(what: string, error: unknown, next: string): Outcome {
  if (error instanceof Refusal) {
    return failed(what, error.reason, `${error.fix}.`);
  }
  const detail = safeReason(error);
  return failed(what, UNEXPECTED, next, detail === "" ? [] : [detail]);
}

export function refusalText(error: unknown, fallback: string): string {
  return error instanceof Refusal ? `${capitalize(error.reason)}. ${error.fix}.` : fallback;
}
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const INCOMPLETE_NEXT = "Your settings were not changed. Try again.";
export const GATEWAY_CHANGED = "the gateway started or stopped since you reviewed";
export const REVIEW_AGAIN = "Nothing was changed. Open Review details, then choose Apply again.";
export const SAVED_NEXT =
  "Choose Reconnect. If that fails, choose Setup › Activate saved configuration.";

export async function attempt(
  what: string,
  next: string,
  work: () => Promise<Outcome>,
): Promise<Outcome> {
  try {
    return await work();
  } catch (error) {
    return failedWith(what, error, next);
  }
}

export class NotActive extends Error {}

export function pendingOutcome(
  what: string,
  next: string = SAVED_NEXT,
  technical: readonly string[] = [],
): Outcome {
  return { ok: false, headline: `! ${what} but not active yet`, facts: [], next, technical };
}

export function afterSave(error: unknown, technical: readonly string[] = []): Outcome {
  if (error instanceof NotActive) {
    return pendingOutcome("Settings saved", error.message, technical);
  }
  const detail = safeReason(error);
  return pendingOutcome("Settings saved", SAVED_NEXT, [
    ...(detail === "" ? [] : [detail]),
    ...technical,
  ]);
}
