import type { PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, expect, test } from "vitest";
import { createDeferredCallCapture, createDeferredPiCallTool } from "../sdk/deferred-tools";
import type { InvalidDeferredCallLimitError } from "../sdk/errors";
import { deliverToolUse, deliverToolUses } from "./fixtures";

function captureFor(...toolNames: readonly string[]) {
  const limitErrors: Readonly<InvalidDeferredCallLimitError>[] = [];
  const capture = createDeferredCallCapture(new Set(toolNames), (error) => {
    limitErrors.push(error);
  });
  return { capture, limitErrors };
}

function denial(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

describe("deferred tool capture", () => {
  test("defers the pi_call gateway tool via a PreToolUse hook instead of denying and aborting", async () => {
    const { capture } = captureFor("read");

    const output = await deliverToolUse(capture.hook, {
      id: "toolu_1",
      input: { name: "read", arguments: { path: "package.json" } },
    });

    expect(capture.calls).toStrictEqual([
      { id: "toolu_1", name: "read", arguments: { path: "package.json" } },
    ]);
    expect(output).toStrictEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" },
    });
  });

  test("preserves batched calls and deduplicates repeated hook delivery by tool-use ID", async () => {
    const { capture } = captureFor("read");

    await deliverToolUses(capture.hook, [
      { id: "toolu_first", input: { name: "read", arguments: { path: "package.json" } } },
      { id: "toolu_first", input: { name: "read", arguments: { path: "package.json" } } },
      { id: "toolu_second", input: { name: "read", arguments: { path: "README.md" } } },
    ]);

    expect(capture.calls).toStrictEqual([
      { id: "toolu_first", name: "read", arguments: { path: "package.json" } },
      { id: "toolu_second", name: "read", arguments: { path: "README.md" } },
    ]);
  });

  test("denies any tool other than the pi_call gateway", async () => {
    const { capture } = captureFor("read");

    const output = await deliverToolUse(capture.hook, {
      id: "toolu_2",
      input: { command: "ls" },
      toolName: "Bash",
    });

    expect(output).toStrictEqual(
      denial("Only the Pi deferred-tool gateway is available, not Bash."),
    );
    expect(capture.calls).toStrictEqual([]);
  });

  test("ignores hook events other than PreToolUse", async () => {
    const { capture } = captureFor("read");
    const input = {
      session_id: "test-session",
      transcript_path: "/dev/null",
      cwd: "/",
      hook_event_name: "PostToolUse",
      tool_name: "mcp__pi__pi_call",
      tool_input: { name: "read", arguments: {} },
      tool_response: {},
      tool_use_id: "toolu_3",
    } satisfies PostToolUseHookInput;

    const output = await capture.hook(input, undefined, { signal: new AbortController().signal });

    expect(output).toStrictEqual({});
  });

  test("fails loudly instead of faking a successful defer when the SDK invokes the MCP gateway directly", async () => {
    const gateway = createDeferredPiCallTool("available tools");

    const result = await gateway.handler(
      { name: "read", arguments: { path: "package.json" } },
      undefined,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    const [content] = result.content;
    assert(content?.type === "text", "test setup: expected text content");
    expect(content.text).not.toContain("Tool execution is deferred to Pi.");
    expect(content.text).toContain("not honored");
  });
});

describe("deferred tool validation", () => {
  test.each([
    [
      "an unknown inner tool name, naming real tools to retry with",
      {
        toolNames: ["read"],
        toolInput: { name: "missing_tool", arguments: {} },
        reason:
          'Invalid Pi tool call: "missing_tool" is not a recognized Pi tool. Available tools: read.',
      },
    ],
    [
      "pi_call passed as its own inner name, with a targeted correction",
      {
        toolNames: ["read", "write"],
        toolInput: { name: "pi_call", arguments: {} },
        reason:
          'Invalid Pi tool call: "pi_call" is this gateway\'s own name, not a Pi tool; do not pass it as the "name" field. ' +
          "Pass the target Pi tool's name instead, e.g. read, write.",
      },
    ],
    [
      "missing arguments, distinctly from an unknown tool name",
      {
        toolNames: ["read"],
        toolInput: { name: "read" },
        reason:
          'Invalid Pi tool call: "arguments" must be an object matching "read"\'s input schema.',
      },
    ],
    [
      "array arguments",
      {
        toolNames: ["read"],
        toolInput: { name: "read", arguments: ["package.json"] },
        reason:
          'Invalid Pi tool call: "arguments" must be an object matching "read"\'s input schema.',
      },
    ],
    [
      "a missing name",
      {
        toolNames: ["read"],
        toolInput: { arguments: {} },
        reason:
          'Invalid Pi tool call: "<missing>" is not a recognized Pi tool. Available tools: read.',
      },
    ],
    [
      "input that is not an object",
      {
        toolNames: [],
        toolInput: "read",
        reason:
          'Invalid Pi tool call: "arguments" must be an object matching "<missing>"\'s input schema.',
      },
    ],
  ])("denies (not fatally) %s", async (_case, { toolNames, toolInput, reason }) => {
    const { capture, limitErrors } = captureFor(...toolNames);

    const output = await deliverToolUse(capture.hook, { id: "toolu_bad", input: toolInput });

    expect(output).toStrictEqual(denial(reason));
    expect(capture.calls).toStrictEqual([]);
    expect(limitErrors).toStrictEqual([]);
  });

  test("tolerates three invalid calls, then reports the fourth exactly once and keeps denying", async () => {
    const { capture, limitErrors } = captureFor("read");
    const invalid = { name: "pi_call", arguments: {} };

    await deliverToolUses(
      capture.hook,
      ["bad_1", "bad_2", "bad_3"].map((id) => ({ id, input: invalid })),
    );
    expect(capture.limitError).toBeUndefined();

    await deliverToolUse(capture.hook, { id: "bad_4", input: invalid });
    const fifth = await deliverToolUse(capture.hook, { id: "bad_5", input: invalid });

    expect(limitErrors).toHaveLength(1);
    expect(capture.limitError).toBe(limitErrors[0]);
    expect(capture.limitError?._tag).toBe("InvalidDeferredCallLimitError");
    expect(capture.limitError?.attempts).toBe(4);
    expect(capture.limitError?.message).toMatch(/pi_call.*is this gateway's own name/u);
    expect(fifth).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });
});
