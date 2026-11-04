import { describe, expect, test } from "vitest";
import { extraUsageAllowed, subscriptionEnvironment } from "../sdk/subscription-environment";

describe("subscription environment", () => {
  test("removes API and cloud-provider credentials from the subscription subprocess", () => {
    const environment = subscriptionEnvironment({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "api-key",
      ANTHROPIC_AUTH_TOKEN: "auth-token",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
    });

    expect(environment.PATH).toBe("/bin");
    expect(environment.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("pi-coding-agent-provider/0.1.0");
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(environment.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(environment.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(environment.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
    expect(environment.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined();
  });

  test("disables the CLI's cache breakpoints and pins the extended-ttl beta the provider breakpoint needs", () => {
    const environment = subscriptionEnvironment({
      FORCE_PROMPT_CACHING_5M: "1",
      ENABLE_PROMPT_CACHING_1H: undefined,
    });

    expect(environment.DISABLE_PROMPT_CACHING).toBe("1");
    expect(environment.FORCE_PROMPT_CACHING_5M).toBe("1");
    expect(environment.ENABLE_PROMPT_CACHING_1H).toBeUndefined();
    expect(environment.ANTHROPIC_BETAS).toBe("extended-cache-ttl-2025-04-11");
  });

  test("appends the extended-cache beta without clobbering existing betas or the experimental-betas opt-out", () => {
    const environment = subscriptionEnvironment({
      ANTHROPIC_BETAS: "context-1m-2025-08-07, extended-cache-ttl-2025-04-11",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    });

    expect(environment.ANTHROPIC_BETAS).toBe("context-1m-2025-08-07,extended-cache-ttl-2025-04-11");
    expect(environment.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("1");
  });

  test("PI_CLAUDE_SDK_CLI_CACHE=1 restores the CLI's native caching policy as an escape hatch", () => {
    const environment = subscriptionEnvironment({
      PI_CLAUDE_SDK_CLI_CACHE: "1",
      FORCE_PROMPT_CACHING_5M: "1",
    });

    expect(environment.DISABLE_PROMPT_CACHING).toBeUndefined();
    expect(environment.FORCE_PROMPT_CACHING_5M).toBe("1");
    expect(environment.ANTHROPIC_BETAS).toBeUndefined();
  });

  test("pins verified background-traffic switches by default and keeps explicit user values", () => {
    const defaults = subscriptionEnvironment({});
    expect(defaults.DISABLE_ERROR_REPORTING).toBe("1");
    expect(defaults.DISABLE_AUTOUPDATER).toBe("1");
    expect(defaults.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY).toBe("1");
    expect(defaults.DISABLE_TELEMETRY).toBeUndefined();
    expect(defaults.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();

    const explicit = subscriptionEnvironment({
      DISABLE_ERROR_REPORTING: "0",
      DISABLE_AUTOUPDATER: "",
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "0",
    });
    expect(explicit.DISABLE_ERROR_REPORTING).toBe("0");
    expect(explicit.DISABLE_AUTOUPDATER).toBe("");
    expect(explicit.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY).toBe("0");
  });

  test("background-traffic pins also apply under the PI_CLAUDE_SDK_CLI_CACHE=1 escape hatch", () => {
    const environment = subscriptionEnvironment({ PI_CLAUDE_SDK_CLI_CACHE: "1" });
    expect(environment.DISABLE_ERROR_REPORTING).toBe("1");
    expect(environment.DISABLE_AUTOUPDATER).toBe("1");
    expect(environment.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY).toBe("1");
    expect(environment.DISABLE_PROMPT_CACHING).toBeUndefined();
  });
});

describe("subscription environment hardening", () => {
  test("strips variables that would break subscription routing or override Pi", () => {
    const environment = subscriptionEnvironment({
      CLAUDE_CODE_SIMPLE: "1",
      CLAUDE_CODE_EFFORT_LEVEL: "max",
      MCP_TOOL_TIMEOUT: "1",
      ANTHROPIC_BASE_URL: "https://example.invalid",
    });
    expect(environment.CLAUDE_CODE_SIMPLE).toBeUndefined();
    expect(environment.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
    expect(environment.MCP_TOOL_TIMEOUT).toBeUndefined();
    expect(environment.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  test("forces Pi-owned feature switches over inherited values", () => {
    const environment = subscriptionEnvironment({
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "0",
      ENABLE_TOOL_SEARCH: "true",
      DISABLE_AUTO_COMPACT: "0",
    });
    expect(environment).toMatchObject({
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      DISABLE_AUTO_COMPACT: "1",
      CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
      ENABLE_TOOL_SEARCH: "false",
      CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
      CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1",
    });
  });

  test("labels the entrypoint honestly and always replaces an inherited one", () => {
    expect(
      subscriptionEnvironment({ CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }).CLAUDE_CODE_ENTRYPOINT,
    ).toBe("pi-claude-sdk");
    expect(
      subscriptionEnvironment({ PI_CLAUDE_SDK_ENTRYPOINT: "my-tool_1.0" }).CLAUDE_CODE_ENTRYPOINT,
    ).toBe("my-tool_1.0");
  });

  test.each([
    "cli",
    "mcp",
    "sdk-cli",
    "sdk-ts",
    "sdk-py",
    "claude-vscode",
    "claude-desktop",
    "claude-desktop-3p",
    "local-agent",
    "claude-anything",
    "remote_x",
    "Upper",
    "",
    "a b",
    "-x",
    "x".repeat(65),
  ])("rejects entrypoint override %j", (value) => {
    expect(
      subscriptionEnvironment({ PI_CLAUDE_SDK_ENTRYPOINT: value }).CLAUDE_CODE_ENTRYPOINT,
    ).toBe("pi-claude-sdk");
  });

  test("extra usage is opt-in", () => {
    expect(extraUsageAllowed({})).toBe(false);
    expect(extraUsageAllowed({ PI_CLAUDE_SDK_ALLOW_EXTRA_USAGE: "true" })).toBe(false);
    expect(extraUsageAllowed({ PI_CLAUDE_SDK_ALLOW_EXTRA_USAGE: "1" })).toBe(true);
  });
});
