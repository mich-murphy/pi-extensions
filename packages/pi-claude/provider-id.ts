/** Provider id this extension registered as pi-claude-sdk; older sessions still hold it. */
const LEGACY_PROVIDER_ID = "claude-sdk";

/**
 * Whether a recorded assistant message came from this provider, under its current or old id.
 *
 * @param provider - The message's `provider` field.
 * @returns True for `claude` and the legacy `claude-sdk`.
 */
export function isClaudeProvider(provider: string): boolean {
  return provider === "claude" || provider === LEGACY_PROVIDER_ID;
}
