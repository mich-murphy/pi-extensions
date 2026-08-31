import process from "node:process";
import { type CacheDiagnosticTracker, createCacheDiagnosticTracker } from "./cache-tracker";

/** Build an opt-in cache tracker from parsed environment values. */
export function cacheDiagnosticsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CacheDiagnosticTracker | undefined {
  if (environment.PI_CLAUDE_SDK_CACHE_DIAGNOSTICS !== "1") return undefined;
  return createCacheDiagnosticTracker((diagnostic) => {
    process.stderr.write(`[claude-sdk-cache] ${JSON.stringify(diagnostic)}\n`);
  });
}
