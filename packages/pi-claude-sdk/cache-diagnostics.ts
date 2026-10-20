import { appendFileSync } from "node:fs";
import { Effect } from "effect";
import { createCacheDiagnosticTracker } from "./cache-tracker";
import type { CacheDiagnosticTracker } from "./cache-tracker";
import { writeRedirectedDiagnostic } from "./diagnostic-output";

/** Where opt-in cache diagnostics go: redirected stderr, an append-only JSONL file, or nowhere. */
export type CacheDiagnosticsMode = "enabled" | "disabled" | { readonly file: string };

/**
 * Parse the cache diagnostics switches from the startup environment.
 *
 * @param environment - Startup environment, read only at the composition root.
 * @returns A file destination when `PI_CLAUDE_SDK_CACHE_DIAGNOSTICS_FILE` is set, `enabled`
 *   when `PI_CLAUDE_SDK_CACHE_DIAGNOSTICS` is exactly `1`, otherwise `disabled`.
 */
export function parseCacheDiagnosticsMode(
  environment: Readonly<Record<string, string | undefined>>,
): CacheDiagnosticsMode {
  const file = environment.PI_CLAUDE_SDK_CACHE_DIAGNOSTICS_FILE;
  if (file !== undefined && file.length > 0) {
    return { file };
  }
  return environment.PI_CLAUDE_SDK_CACHE_DIAGNOSTICS === "1" ? "enabled" : "disabled";
}

function appendDiagnostic(file: string, line: string): void {
  try {
    appendFileSync(file, line, { mode: 0o600 });
  } catch {
    // Diagnostics are best effort: an unwritable file must never fail a turn.
  }
}

/**
 * Build the opt-in cache tracker, timed by the `Clock` in scope.
 *
 * @param mode - Parsed diagnostics destination.
 * @returns A tracker writing to its destination, or undefined when diagnostics are disabled.
 */
export const cacheDiagnosticsTracker = Effect.fnUntraced(function* (
  mode: CacheDiagnosticsMode,
): Effect.fn.Return<CacheDiagnosticTracker | undefined> {
  if (mode === "disabled") {
    return undefined;
  }
  return yield* createCacheDiagnosticTracker((diagnostic) => {
    const record = JSON.stringify(diagnostic);
    if (mode === "enabled") {
      writeRedirectedDiagnostic(`[claude-sdk-cache] ${record}\n`);
    } else {
      appendDiagnostic(mode.file, `${record}\n`);
    }
  });
});
