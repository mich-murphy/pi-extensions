import type { Outcome } from "./menu/progress.js";

/** Our own refusals explain themselves; anything that may quote a path or file content does not. */
const SAFE_REASON = /^[\p{L}\p{N} .,;:()'’—–-]{1,240}$/u;
export function safeReason(
  error: unknown,
  fallback = "it did not finish; details withheld",
): string {
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

/** A failed action: `✗ <what> — <reason>`, the plain next step, and internals kept technical. */
export function failed(
  what: string,
  reason: string,
  next: string,
  technical: readonly string[] = [],
): Outcome {
  return { ok: false, headline: `✗ ${what} — ${reason}`, facts: [], next, technical };
}

export const INCOMPLETE_NEXT =
  "Nothing you had before was changed. Choose Doctor to see what failed, then try Apply again.";
export const SAVED_NEXT =
  "Choose Reconnect; if it still waits, choose Setup › Activate saved configuration.";

/** Runs `work`; an error becomes a failed outcome with a safe reason. */
export async function attempt(
  what: string,
  next: string,
  work: () => Promise<Outcome>,
): Promise<Outcome> {
  try {
    return await work();
  } catch (error) {
    return failed(what, safeReason(error), next);
  }
}

/** An activation refusal whose message is plain text for the user (for example, a busy Pi). */
export class NotActive extends Error {}

/** Settings were saved but are not active yet: `! <what> — not active yet`. */
export function pendingOutcome(
  what: string,
  next: string = SAVED_NEXT,
  technical: readonly string[] = [],
): Outcome {
  return { ok: false, headline: `! ${what} — not active yet`, facts: [], next, technical };
}

/** The outcome of an error after settings were saved: never a replay, never jargon first. */
export function afterSave(error: unknown, technical: readonly string[] = []): Outcome {
  return error instanceof NotActive
    ? pendingOutcome("Settings saved", error.message, technical)
    : pendingOutcome("Settings saved", SAVED_NEXT, [safeReason(error), ...technical]);
}
