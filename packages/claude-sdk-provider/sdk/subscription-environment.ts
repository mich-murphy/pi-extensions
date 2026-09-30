// The API beta required for ttl: "1h" cache-control blocks.
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

  // The CLI places cache breakpoints of its own (system blocks, the trailing
  // environment message, and possibly more as its policy evolves) on top of
  // the single transcript-prefix breakpoint this provider supplies. Anthropic
  // rejects requests with more than four cache_control blocks, so the CLI's
  // automatic caching must stay off: its breakpoints sit on blocks far below
  // the 1024-token cache-creation minimum anyway, while the transcript prefix
  // this provider marks is where the tokens are. PI_CLAUDE_SDK_5M_CACHE
  // restores the CLI's native policy as an escape hatch.
  if (environment.PI_CLAUDE_SDK_5M_CACHE === "1") return environment;
  environment.DISABLE_PROMPT_CACHING = "1";
  delete environment.FORCE_PROMPT_CACHING_5M;
  environment.ENABLE_PROMPT_CACHING_1H = "1";
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
