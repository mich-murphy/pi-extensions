import { execFileSync } from "node:child_process";
import process from "node:process";
import { isBelowMinimumClaudeCode, resolveClaudeExecutable } from "../sdk/claude-executable";

/**
 * Executable for tests that spawn a real CLI: the same installed Claude Code production resolves.
 * The SDK's platform binaries are overridden to an empty stub, so there is no bundled fallback.
 * Only darwin-only offline contracts and the live gate call this; CI on Ubuntu never does.
 */
export function testClaudeExecutable(): string {
  const path = resolveClaudeExecutable(process.env);
  if (path === undefined) {
    throw new Error("No Claude Code found: install it or set PI_CLAUDE_SDK_CLAUDE_PATH");
  }
  const version = execFileSync(path, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (isBelowMinimumClaudeCode(version)) {
    throw new Error(`Claude Code ${version.trim()} at ${path} is too old: run \`claude update\``);
  }
  return path;
}
