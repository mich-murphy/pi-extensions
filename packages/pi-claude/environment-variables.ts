/**
 * Settings read from the environment, mapped to the name they had as pi-claude-sdk. The current
 * name wins whenever it is defined, even when empty; the old name is read only as a fallback.
 */
const LEGACY_NAMES = {
  PI_CLAUDE_PATH: "PI_CLAUDE_SDK_CLAUDE_PATH",
  PI_CLAUDE_ALLOW_EXTRA_USAGE: "PI_CLAUDE_SDK_ALLOW_EXTRA_USAGE",
  PI_CLAUDE_ENTRYPOINT: "PI_CLAUDE_SDK_ENTRYPOINT",
  PI_CLAUDE_CLI_CACHE: "PI_CLAUDE_SDK_CLI_CACHE",
  PI_CLAUDE_CACHE_DIAGNOSTICS: "PI_CLAUDE_SDK_CACHE_DIAGNOSTICS",
  PI_CLAUDE_CACHE_DIAGNOSTICS_FILE: "PI_CLAUDE_SDK_CACHE_DIAGNOSTICS_FILE",
} as const;

/**
 * Read one of the provider's environment settings, falling back to its pi-claude-sdk name.
 *
 * @param environment - Environment to read.
 * @param name - Current variable name.
 * @returns The current variable when defined, otherwise the legacy one.
 */
export function claudeVariable(
  environment: Readonly<Record<string, string | undefined>>,
  name: keyof typeof LEGACY_NAMES,
): string | undefined {
  return environment[name] ?? environment[LEGACY_NAMES[name]];
}
