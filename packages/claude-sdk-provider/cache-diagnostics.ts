import process from "node:process";
import { Effect } from "effect";
import { createCacheDiagnosticTracker } from "./cache-tracker";
import type { CacheDiagnosticTracker } from "./cache-tracker";

/** Whether opt-in cache diagnostics are written to stderr. */
export type CacheDiagnosticsMode = "enabled" | "disabled";

/**
 * Parse the cache diagnostics switch from the startup environment.
 *
 * @param environment - Startup environment, read only at the composition root.
 * @returns `enabled` only when `PI_CLAUDE_SDK_CACHE_DIAGNOSTICS` is exactly `1`.
 */
export function parseCacheDiagnosticsMode(
  environment: Readonly<Record<string, string | undefined>>,
): CacheDiagnosticsMode {
  return environment.PI_CLAUDE_SDK_CACHE_DIAGNOSTICS === "1" ? "enabled" : "disabled";
}

/**
 * Build the opt-in cache tracker, timed by the `Clock` in scope.
 *
 * @param mode - Parsed diagnostics switch.
 * @returns A tracker writing to stderr, or undefined when diagnostics are disabled.
 */
export const cacheDiagnosticsTracker = Effect.fnUntraced(function* (
  mode: CacheDiagnosticsMode,
): Effect.fn.Return<CacheDiagnosticTracker | undefined> {
  if (mode === "disabled") {
    return undefined;
  }
  return yield* createCacheDiagnosticTracker((diagnostic) => {
    process.stderr.write(`[claude-sdk-cache] ${JSON.stringify(diagnostic)}\n`);
  });
});
