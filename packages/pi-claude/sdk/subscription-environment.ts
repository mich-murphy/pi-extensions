import process from "node:process";
import { claudeVariable } from "../environment-variables";

const EXTENDED_CACHE_TTL_BETA = "extended-cache-ttl-2025-04-11";

const NON_SUBSCRIPTION_AUTH_VARIABLES: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
]);

const STRIPPED_VARIABLE_GROUPS = {
  simpleModeNeverReadsSubscriptionOAuth: ["CLAUDE_CODE_SIMPLE"],
  overridesPiSelectedReasoningEffort: ["CLAUDE_CODE_EFFORT_LEVEL"],
  changesDeferredToolBridgeTimeout: ["MCP_TOOL_TIMEOUT"],
  sendsSubscriptionTokenToAnotherHost: ["ANTHROPIC_BASE_URL"],
  addsHiddenRetriesInsidePiAttempts: [
    "CLAUDE_CODE_MAX_RETRIES",
    "CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES",
    "CLAUDE_CODE_RETRY_WATCHDOG",
    "CLAUDE_CODE_RETRY_WATCHDOG_SCOPE",
    "CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS",
    "CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS",
    "CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS",
    "CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS",
    "CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS",
    "CLAUDE_CODE_OVERLOADED_RETRY_MAX_WAIT_MS",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const STRIPPED_VARIABLES: ReadonlySet<string> = new Set(
  Object.values(STRIPPED_VARIABLE_GROUPS).flat(),
);

const PI_OWNED_FEATURE_SWITCHES = {
  piLoadsProjectInstructions: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" },
  piOwnsMemory: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
  piOwnsCompaction: { DISABLE_AUTO_COMPACT: "1" },
  noModelRequestsPiNeverSees: {
    CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
    CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
  },
  piAdvertisesEveryToolUpFront: { ENABLE_TOOL_SEARCH: "false" },
  noHiddenResendOrModelSwitchAfterOutput: {
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
    CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1",
    CLAUDE_CODE_DISABLE_REFUSAL_RETRY: "1",
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, string>>>>;

const FORCED_VARIABLES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.values(PI_OWNED_FEATURE_SWITCHES).flatMap((group) => Object.entries(group)),
);

const DEFAULT_ENTRYPOINT = "pi-claude";
const ENTRYPOINT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const IMPERSONATED_ENTRYPOINTS: ReadonlySet<string> = new Set([
  "cli",
  "mcp",
  "sdk-cli",
  "sdk-ts",
  "sdk-py",
  "claude-vscode",
  "claude-desktop",
  "claude-desktop-3p",
  "local-agent",
]);

function entrypointLabel(override: string | undefined): string {
  if (
    override === undefined ||
    !ENTRYPOINT_PATTERN.test(override) ||
    IMPERSONATED_ENTRYPOINTS.has(override) ||
    override.startsWith("claude-") ||
    override.startsWith("remote_")
  ) {
    return DEFAULT_ENTRYPOINT;
  }
  return override;
}

const BACKGROUND_TRAFFIC_PINS = {
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
};

export function subscriptionEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const environment = Object.fromEntries(
    Object.entries(source).filter(
      ([name]) => !NON_SUBSCRIPTION_AUTH_VARIABLES.has(name) && !STRIPPED_VARIABLES.has(name),
    ),
  );
  Object.assign(environment, FORCED_VARIABLES);
  environment.CLAUDE_CODE_ENTRYPOINT = entrypointLabel(
    claudeVariable(source, "PI_CLAUDE_ENTRYPOINT"),
  );
  environment.CLAUDE_AGENT_SDK_CLIENT_APP = "pi-coding-agent-provider/0.1.0";
  for (const [name, value] of Object.entries(BACKGROUND_TRAFFIC_PINS)) {
    environment[name] ??= value;
  }

  if (claudeVariable(source, "PI_CLAUDE_CLI_CACHE") === "1") {
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

export function extraUsageAllowed(
  source: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return claudeVariable(source, "PI_CLAUDE_ALLOW_EXTRA_USAGE") === "1";
}
