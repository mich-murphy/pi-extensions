const LEGACY_PROVIDER_ID = "claude-sdk";

export function isClaudeProvider(provider: string): boolean {
  return provider === "claude" || provider === LEGACY_PROVIDER_ID;
}
