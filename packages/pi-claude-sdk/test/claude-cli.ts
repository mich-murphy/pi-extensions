import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";
import { isBelowMinimumClaudeCode, resolveClaudeExecutable } from "../sdk/claude-executable";

function isTooOld(path: string): boolean {
  try {
    return isBelowMinimumClaudeCode(
      execFileSync(path, ["--version"], { encoding: "utf8", timeout: 10_000 }),
    );
  } catch {
    return true;
  }
}

/**
 * Executable for tests that spawn a real CLI. Production resolution first; CI on Ubuntu has no
 * system `claude`, so TEST CODE ONLY falls back to the SDK's installed platform binary.
 */
export function testClaudeExecutable(): string {
  const system = resolveClaudeExecutable(process.env);
  // A system CLI older than the minimum cannot honor onFailure hooks; use the SDK binary then.
  if (system !== undefined && !isTooOld(system)) {
    return system;
  }
  const require = createRequire(import.meta.url);
  const suffixes = process.platform === "linux" ? ["", "-musl"] : [""];
  for (const suffix of suffixes) {
    try {
      return require.resolve(
        `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${suffix}/claude`,
      );
    } catch {
      // try the next variant
    }
  }
  throw new Error("No Claude Code found: install it or set PI_CLAUDE_SDK_CLAUDE_PATH");
}
