import { describe, expect, test } from "vitest";
import { subscriptionEnvironment } from "../sdk/subscription-environment";

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
