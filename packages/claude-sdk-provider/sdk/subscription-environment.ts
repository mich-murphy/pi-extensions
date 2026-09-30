import process from "node:process";

const EXTENDED_CACHE_TTL_BETA = "extended-cache-ttl-2025-04-11";

const NON_SUBSCRIPTION_AUTH_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

/**
 * Build the sanitized environment used by the subscription-authenticated SDK subprocess.
 *
 * @param source - Startup environment to copy and sanitize.
 * @returns A fresh environment with non-subscription credentials removed.
 */
export function subscriptionEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const environment = { ...source };
  for (const name of NON_SUBSCRIPTION_AUTH_VARIABLES) {
    delete environment[name];
  }
  environment.CLAUDE_AGENT_SDK_CLIENT_APP = "pi-coding-agent-provider/0.1.0";

  // Anthropic rejects more than four cache_control blocks, so the CLI's own breakpoints stay off.
  if (environment.PI_CLAUDE_SDK_CLI_CACHE === "1") return environment;
  environment.DISABLE_PROMPT_CACHING = "1";

  // The provider's ttl: "1h" breakpoint is rejected without this beta.
  const betas = new Set(
    (environment.ANTHROPIC_BETAS ?? "")
      .split(",")
      .map((beta) => beta.trim())
      .filter(Boolean),
  );
  betas.add(EXTENDED_CACHE_TTL_BETA);
  environment.ANTHROPIC_BETAS = [...betas].join(",");
  return environment;
}
