import process from "node:process";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { parseCacheDiagnosticsMode } from "../cache-diagnostics";
import { claudeVariable } from "../environment-variables";
import { minimumCacheableTokensFor } from "../models";
import { isClaudeProvider } from "../provider-id";
import { resolveClaudeExecutable } from "../sdk/claude-executable";
import { extraUsageAllowed, subscriptionEnvironment } from "../sdk/subscription-environment";
import {
  normalizeValidationResult,
  VALIDATION_ERROR_TOOL,
  validationRecoveryReason,
} from "../validation-recovery";

function label(source: Record<string, string>): string | undefined {
  return subscriptionEnvironment(source).CLAUDE_CODE_ENTRYPOINT;
}

const RENAMED = [
  ["PI_CLAUDE_PATH", "PI_CLAUDE_SDK_CLAUDE_PATH"],
  ["PI_CLAUDE_ALLOW_EXTRA_USAGE", "PI_CLAUDE_SDK_ALLOW_EXTRA_USAGE"],
  ["PI_CLAUDE_ENTRYPOINT", "PI_CLAUDE_SDK_ENTRYPOINT"],
  ["PI_CLAUDE_CLI_CACHE", "PI_CLAUDE_SDK_CLI_CACHE"],
  ["PI_CLAUDE_CACHE_DIAGNOSTICS", "PI_CLAUDE_SDK_CACHE_DIAGNOSTICS"],
  ["PI_CLAUDE_CACHE_DIAGNOSTICS_FILE", "PI_CLAUDE_SDK_CACHE_DIAGNOSTICS_FILE"],
] as const;

describe("environment variables renamed from PI_CLAUDE_SDK_*", () => {
  test.each(RENAMED)("%s wins over %s, which is still read", (current, legacy) => {
    expect(claudeVariable({ [legacy]: "old" }, current)).toBe("old");
    expect(claudeVariable({ [current]: "new" }, current)).toBe("new");
    expect(claudeVariable({ [current]: "new", [legacy]: "old" }, current)).toBe("new");
    expect(claudeVariable({ [current]: "", [legacy]: "old" }, current)).toBe("");
    expect(claudeVariable({}, current)).toBeUndefined();
  });

  test("every reader honours the legacy name", () => {
    expect(
      resolveClaudeExecutable(
        { PI_CLAUDE_SDK_CLAUDE_PATH: process.execPath, PATH: "" },
        process.platform,
      ),
    ).toBe(process.execPath);
    expect(extraUsageAllowed({ PI_CLAUDE_SDK_ALLOW_EXTRA_USAGE: "1" })).toBe(true);
    expect(
      extraUsageAllowed({ PI_CLAUDE_SDK_ALLOW_EXTRA_USAGE: "1", PI_CLAUDE_ALLOW_EXTRA_USAGE: "0" }),
    ).toBe(false);
    expect(parseCacheDiagnosticsMode({ PI_CLAUDE_SDK_CACHE_DIAGNOSTICS: "1" })).toBe("enabled");
    expect(
      parseCacheDiagnosticsMode({ PI_CLAUDE_SDK_CACHE_DIAGNOSTICS_FILE: "/tmp/c" }),
    ).toStrictEqual({ file: "/tmp/c" });
    expect(
      subscriptionEnvironment({ PI_CLAUDE_SDK_CLI_CACHE: "1" }).DISABLE_PROMPT_CACHING,
    ).toBeUndefined();
  });

  test("a legacy entrypoint label passes the same checks as a current one", () => {
    expect(label({})).toBe("pi-claude");
    expect(label({ PI_CLAUDE_SDK_ENTRYPOINT: "my-tool" })).toBe("my-tool");
    expect(label({ PI_CLAUDE_SDK_ENTRYPOINT: "sdk-cli" })).toBe("pi-claude");
    expect(label({ PI_CLAUDE_SDK_ENTRYPOINT: "claude-x" })).toBe("pi-claude");
    expect(label({ PI_CLAUDE_SDK_ENTRYPOINT: "my-tool", PI_CLAUDE_ENTRYPOINT: "cli" })).toBe(
      "pi-claude",
    );
  });

  test("the child environment passes both names through unchanged", () => {
    const source = Object.fromEntries(RENAMED.flat().map((name) => [name, "x"]));

    const environment = subscriptionEnvironment(source);

    for (const name of RENAMED.flat()) {
      expect(environment[name]).toBe("x");
    }
  });
});

function assistant(provider: string): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call-1",
        name: VALIDATION_ERROR_TOOL,
        arguments: { error: "printed_tool_call" },
      },
    ],
    api: provider,
    provider,
    model: "claude-5.5-sonnet",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  };
}

const rejection: ToolResultMessage = {
  role: "toolResult",
  toolCallId: "call-1",
  toolName: VALIDATION_ERROR_TOOL,
  content: [{ type: "text", text: validationRecoveryReason({ error: "printed_tool_call" }) }],
  isError: true,
  timestamp: 0,
};

describe("history recorded under the claude-sdk provider id", () => {
  test("is still recognised as this provider's", () => {
    expect(isClaudeProvider("claude")).toBe(true);
    expect(isClaudeProvider("claude-sdk")).toBe(true);
    expect(isClaudeProvider("anthropic")).toBe(false);
  });

  test("validation recovery normalizes a legacy assistant's synthetic call", () => {
    const current = normalizeValidationResult(rejection, [assistant("claude")]);

    expect(current).toBeDefined();
    expect(normalizeValidationResult(rejection, [assistant("claude-sdk")])).toStrictEqual(current);
    expect(normalizeValidationResult(rejection, [assistant("anthropic")])).toBeUndefined();
  });

  test("a claude-sdk/ model prefix resolves the same cache minimum", () => {
    const current = minimumCacheableTokensFor("claude/claude-5.5-sonnet");

    expect(current).toBeDefined();
    expect(minimumCacheableTokensFor("claude-sdk/claude-5.5-sonnet")).toBe(current);
  });
});
