import { appendFileSync } from "node:fs";
import { Effect } from "effect";
import { createCacheDiagnosticTracker } from "./cache-tracker";
import type { CacheDiagnosticTracker } from "./cache-tracker";
import { writeRedirectedDiagnostic } from "./diagnostic-output";
import { claudeVariable } from "./environment-variables";

export type CacheDiagnosticsMode = "enabled" | "disabled" | { readonly file: string };

export function parseCacheDiagnosticsMode(
  environment: Readonly<Record<string, string | undefined>>,
): CacheDiagnosticsMode {
  const file = claudeVariable(environment, "PI_CLAUDE_CACHE_DIAGNOSTICS_FILE");

  if (file !== undefined && file.length > 0) {
    return { file };
  }

  return claudeVariable(environment, "PI_CLAUDE_CACHE_DIAGNOSTICS") === "1"
    ? "enabled"
    : "disabled";
}

function appendDiagnostic(file: string, line: string): void {
  try {
    appendFileSync(file, line, { mode: 0o600 });
  } catch {
    return undefined;
  }
}

export const cacheDiagnosticsTracker = Effect.fnUntraced(function* (
  mode: CacheDiagnosticsMode,
): Effect.fn.Return<CacheDiagnosticTracker | undefined> {
  if (mode === "disabled") {
    return undefined;
  }

  return yield* createCacheDiagnosticTracker((diagnostic) => {
    const record = JSON.stringify(diagnostic);

    if (mode === "enabled") {
      writeRedirectedDiagnostic(`[claude-cache] ${record}\n`);
    } else {
      appendDiagnostic(mode.file, `${record}\n`);
    }
  });
});
