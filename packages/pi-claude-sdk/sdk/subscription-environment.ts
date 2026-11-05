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
 * Variables removed from the inherited environment (modelled on OpenCode's ISOLATION_ENV).
 * Evidence: strings of Claude Code 2.1.316.
 */
const STRIPPED_VARIABLES: ReadonlySet<string> = new Set([
  // Simple mode reads only API keys ("OAuth and keychain are never read"), breaking subscription auth.
  "CLAUDE_CODE_SIMPLE",
  // Would override the per-turn reasoning effort Pi selects.
  "CLAUDE_CODE_EFFORT_LEVEL",
  // A user-wide MCP timeout would alter Pi's deferred-tool bridge behaviour.
  "MCP_TOOL_TIMEOUT",
  // Would send the subscription OAuth token to another host; routing is subscription-only.
  "ANTHROPIC_BASE_URL",
]);

/**
 * Variables forced on every turn because Pi owns the feature; Claude Code's version would add
 * tokens or change behaviour. Pi owns memory and context, so changing behaviour is the point.
 */
const FORCED_VARIABLES: Readonly<Record<string, string>> = {
  // Pi supplies project instructions; do not load CLAUDE.md files a second time.
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  // Pi owns memory; Claude Code's auto-memory would inject and write its own.
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  // Pi owns compaction; an SDK-side compaction would silently rewrite context.
  DISABLE_AUTO_COMPACT: "1",
  // The "while you were away" recap is an extra model request Pi never shows.
  CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
  // Pi advertises its own tool catalog; deferred tool search would hide tools (falsy value => standard).
  ENABLE_TOOL_SEARCH: "false",
  // The advisor tool adds a sub-model request outside Pi's control.
  CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
  // A non-streaming retry would re-issue a request Pi already saw fail.
  CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
  // A refusal fallback would silently switch model; Pi surfaces the refusal instead.
  CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1",
};

const DEFAULT_ENTRYPOINT = "pi-claude-sdk";
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

/** Honest client label: the override must be well formed and must not name an Anthropic client. */
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

/**
 * Background-traffic switches verified in Claude Code 2.1.310 (strings of the bundled binary).
 * Each is pinned only when the user has not defined it, so explicit choices win.
 *
 * Deliberately NOT pinned: DISABLE_TELEMETRY and CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC also turn off
 * feature-flag evaluation and other non-essential calls whose effect on usage, status and model
 * metadata cannot be established offline.
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
    Object.entries(source).filter(
      ([name]) => !NON_SUBSCRIPTION_AUTH_VARIABLES.has(name) && !STRIPPED_VARIABLES.has(name),
    ),
  );
  Object.assign(environment, FORCED_VARIABLES);
  // Always replace an inherited label (Pi launched from Claude Code inherits "sdk-cli").
  environment.CLAUDE_CODE_ENTRYPOINT = entrypointLabel(source.PI_CLAUDE_SDK_ENTRYPOINT);
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

/**
 * Whether the user opted in to turns billed to Extra Usage (overage) instead of failing them.
 *
 * @param source - Environment to read.
 * @returns True only for PI_CLAUDE_SDK_ALLOW_EXTRA_USAGE=1.
 */
export function extraUsageAllowed(
  source: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return source.PI_CLAUDE_SDK_ALLOW_EXTRA_USAGE === "1";
}
