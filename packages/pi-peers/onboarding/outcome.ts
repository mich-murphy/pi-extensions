import type { Outcome } from "./menu/progress.js";
import { Refusal } from "./refusal.js";

/** Our own refusals explain themselves; anything that may quote a path or file content does not. */
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

/** The reason shown for an error that was not written for the user. */
const UNEXPECTED = "unexpected error";

/** A failed action: `✗ <what>: <reason>`, one plain next step, and raw detail kept technical. */
export function failed(
  what: string,
  reason: string,
  next: string,
  technical: readonly string[] = [],
): Outcome {
  return { ok: false, headline: `✗ ${what}: ${reason}`, facts: [], next, technical };
}

/**
 * A failed action from `error`. A Refusal shows its own reason and fix; any other error shows a
 * generic reason with `next`, and its message (when it quotes no path or content) as detail.
 */
export function failedWith(what: string, error: unknown, next: string): Outcome {
  if (error instanceof Refusal) {
    return failed(what, error.reason, `${error.fix}.`);
  }
  const detail = safeReason(error);
  return failed(what, UNEXPECTED, next, detail === "" ? [] : [detail]);
}

/** One plain sentence for a notification: a Refusal's reason and fix, otherwise `fallback`. */
export function refusalText(error: unknown, fallback: string): string {
  return error instanceof Refusal ? `${capitalize(error.reason)}. ${error.fix}.` : fallback;
}
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const INCOMPLETE_NEXT = "Your settings were not changed. Try again.";
/** Another Pi started or stopped the shared gateway after the review. */
export const GATEWAY_CHANGED = "the gateway started or stopped since you reviewed";
export const REVIEW_AGAIN = "Nothing was changed. Open Review details, then choose Apply again.";
export const SAVED_NEXT =
  "Choose Reconnect. If that fails, choose Setup › Activate saved configuration.";

/** Runs `work`; an error becomes a failed outcome. */
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

/** An activation refusal whose message is the plain next step (for example, a busy Pi). */
export class NotActive extends Error {}

/** Settings were saved but are not active yet: `! <what> but not active yet`. */
export function pendingOutcome(
  what: string,
  next: string = SAVED_NEXT,
  technical: readonly string[] = [],
): Outcome {
  return { ok: false, headline: `! ${what} but not active yet`, facts: [], next, technical };
}

/** The outcome of an error after settings were saved: never a replay, never jargon first. */
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
