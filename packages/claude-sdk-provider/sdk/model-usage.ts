import { record } from "./event-translation";

/** A model resolution observed from a real turn. */
export interface ModelObservation {
  /** Claude Code model selector the request used. */
  readonly selector: string;
  /** Concrete main-loop model id that served the turn, e.g. "claude-fable-5-1". */
  readonly canonicalModel: string;
  /** Context window the request actually ran with, when reported. */
  readonly contextWindow: number | undefined;
}

function modelOf(message: Record<string, unknown> | undefined): string | undefined {
  const model = message?.model;
  return typeof model === "string" && model.length > 0 ? model : undefined;
}

/**
 * Extract the concrete main-loop model from an SDK stream message.
 *
 * The main conversation's `message_start` and `assistant` messages carry the
 * model that served them, unlike the result's `modelUsage`, which also
 * aggregates auxiliary pipeline calls under their own model ids. The first
 * main-loop model in a turn is stable, so callers keep the first value.
 *
 * @param message - One SDK stream message.
 * @returns Concrete model id, or undefined when the message names none.
 */
export function mainLoopModel(message: Record<string, unknown> | undefined): string | undefined {
  if (message?.type === "assistant") return modelOf(record(message.message));
  if (message?.type !== "stream_event") return undefined;
  const event = record(message.event);
  return event?.type === "message_start" ? modelOf(record(event.message)) : undefined;
}

/**
 * Read the context window the SDK reported for a concrete model id.
 *
 * Entries are keyed by the raw model string of each request, which may carry
 * a date suffix, so an entry matches when its key or its `canonicalModel`
 * equals the observed main-loop model.
 *
 * @param message - Terminal SDK result message.
 * @param model - Concrete main-loop model id observed for the turn.
 * @returns Context window in tokens, or undefined when unreported.
 */
export function contextWindowForModel(
  message: Record<string, unknown>,
  model: string,
): number | undefined {
  const modelUsage = record(message.modelUsage);
  if (!modelUsage) return undefined;
  for (const [key, value] of Object.entries(modelUsage)) {
    const entry = record(value);
    if (!entry || (key !== model && entry.canonicalModel !== model)) continue;
    const window = entry.contextWindow;
    if (typeof window === "number" && Number.isInteger(window) && window > 0) return window;
  }
  return undefined;
}
