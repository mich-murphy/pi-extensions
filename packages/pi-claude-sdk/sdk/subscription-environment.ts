import process from "node:process";

const EXTENDED_CACHE_TTL_BETA = "extended-cache-ttl-2025-04-11";

const NON_SUBSCRIPTION_AUTH_VARIABLES: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
]);

/**
 * Background-traffic switches verified in Claude Code 2.1.310 (strings of the bundled binary).
 * Each is pinned only when the user has not defined it, so explicit choices win.
 *
 * Deliberately NOT pinned: DISABLE_TELEMETRY and CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC also turn off
 * feature-flag evaluation and other non-essential calls whose effect on usage, status and model
 * metadata cannot be established offline; CLAUDE_CODE_DISABLE_AUTO_MEMORY changes behaviour, not traffic.
 */
const BACKGROUND_TRAFFIC_PINS: Readonly<Record<string, string>> = {
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
};

/**
 * Build the sanitized environment used by the subscription-authenticated SDK subprocess.
 *
 * @param source - Startup environment to copy and sanitize.
 * @returns A fresh environment with non-subscription credentials removed.
 */
export function subscriptionEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const environment = Object.fromEntries(
    Object.entries(source).filter(([name]) => !NON_SUBSCRIPTION_AUTH_VARIABLES.has(name)),
  );
  environment.CLAUDE_AGENT_SDK_CLIENT_APP = "pi-coding-agent-provider/0.1.0";
  for (const [name, value] of Object.entries(BACKGROUND_TRAFFIC_PINS)) {
    environment[name] ??= value;
  }

  if (environment.PI_CLAUDE_SDK_CLI_CACHE === "1") {
    return environment;
  }
  environment.DISABLE_PROMPT_CACHING = "1";

  const betas = new Set([
    ...(environment.ANTHROPIC_BETAS ?? "")
      .split(",")
      .map((beta) => beta.trim())
      .filter(Boolean),
    EXTENDED_CACHE_TTL_BETA,
  ]);
  environment.ANTHROPIC_BETAS = [...betas].join(",");
  return environment;
}
