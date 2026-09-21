import { describe, expect, test } from "vitest";
import { createDeferredCallCapture, createDeferredPiCallTool } from "../sdk/deferred-tools";
import type { InvalidDeferredCallLimitError } from "../sdk/errors";
import { deliverToolUse } from "./fixtures";

function captureFor(...toolNames: string[]) {
  const limitErrors: InvalidDeferredCallLimitError[] = [];
  const capture = createDeferredCallCapture(new Set(toolNames), (error) => limitErrors.push(error));
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

    const output = await deliverToolUse(capture.hook, "toolu_1", {
      name: "read",
      arguments: { path: "package.json" },
    });

    expect(capture.calls).toEqual([
      { id: "toolu_1", name: "read", arguments: { path: "package.json" } },
    ]);
    expect(output).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" },
    });
  });

  test("preserves batched calls and deduplicates repeated hook delivery by tool-use ID", async () => {
    const { capture } = captureFor("read");

    for (const [id, path] of [
      ["toolu_first", "package.json"],
      ["toolu_first", "package.json"],
      ["toolu_second", "README.md"],
    ] as const) {
      await deliverToolUse(capture.hook, id, { name: "read", arguments: { path } });
    }

    expect(capture.calls).toEqual([
      { id: "toolu_first", name: "read", arguments: { path: "package.json" } },
      { id: "toolu_second", name: "read", arguments: { path: "README.md" } },
    ]);
  });

  test("denies any tool other than the pi_call gateway", async () => {
    const { capture } = captureFor("read");

    const output = await deliverToolUse(capture.hook, "toolu_2", { command: "ls" }, "Bash");

    expect(output).toEqual(denial("Only the Pi deferred-tool gateway is available, not Bash."));
    expect(capture.calls).toEqual([]);
  });

  test("ignores hook events other than PreToolUse", async () => {
    const { capture } = captureFor("read");
    // SAFETY: Only hook_event_name is read before the hook returns for a foreign event.
    const input = { hook_event_name: "PostToolUse" } as Parameters<typeof capture.hook>[0];

    const output = await capture.hook(input, undefined, { signal: new AbortController().signal });

    expect(output).toEqual({});
  });

  test("fails loudly instead of faking a successful defer when the SDK invokes the MCP gateway directly", async () => {
    const gateway = createDeferredPiCallTool("available tools");

    const result = await gateway.handler(
      { name: "read", arguments: { path: "package.json" } },
      undefined,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    const content = result.content[0];
    if (content?.type !== "text") throw new Error("test setup: expected text content");
    expect(content.text).not.toContain("Tool execution is deferred to Pi.");
    expect(content.text).toContain("not honored");
  });
});

describe("deferred tool validation", () => {
  test.each([
    [
      "an unknown inner tool name, naming real tools to retry with",
      ["read"],
      { name: "missing_tool", arguments: {} },
      'Invalid Pi tool call: "missing_tool" is not a recognized Pi tool. Available tools: read.',
    ],
    [
      "pi_call passed as its own inner name, with a targeted correction",
      ["read", "write"],
      { name: "pi_call", arguments: {} },
      'Invalid Pi tool call: "pi_call" is this gateway\'s own name, not a Pi tool; do not pass it as the "name" field. ' +
        "Pass the target Pi tool's name instead, e.g. read, write.",
    ],
    [
      "missing arguments, distinctly from an unknown tool name",
      ["read"],
      { name: "read" },
      'Invalid Pi tool call: "arguments" must be an object matching "read"\'s input schema.',
    ],
    [
      "array arguments",
      ["read"],
      { name: "read", arguments: ["package.json"] },
      'Invalid Pi tool call: "arguments" must be an object matching "read"\'s input schema.',
    ],
    [
      "a missing name",
      ["read"],
      { arguments: {} },
      'Invalid Pi tool call: "<missing>" is not a recognized Pi tool. Available tools: read.',
    ],
    [
      "input that is not an object",
      [],
      "read",
      'Invalid Pi tool call: "arguments" must be an object matching "<missing>"\'s input schema.',
    ],
  ])("denies (not fatally) %s", async (_case, toolNames, toolInput, reason) => {
    const { capture, limitErrors } = captureFor(...toolNames);

    const output = await deliverToolUse(capture.hook, "toolu_bad", toolInput);

    expect(output).toEqual(denial(reason));
    expect(capture.calls).toEqual([]);
    expect(limitErrors).toEqual([]);
  });

  test("tolerates three invalid calls, then reports the fourth exactly once and keeps denying", async () => {
    const { capture, limitErrors } = captureFor("read");
    const invalid = { name: "pi_call", arguments: {} };

    for (const id of ["bad_1", "bad_2", "bad_3"]) await deliverToolUse(capture.hook, id, invalid);
    expect(capture.limitError).toBeUndefined();

    await deliverToolUse(capture.hook, "bad_4", invalid);
    const fifth = await deliverToolUse(capture.hook, "bad_5", invalid);

    expect(limitErrors).toHaveLength(1);
    expect(capture.limitError).toBe(limitErrors[0]);
    expect(capture.limitError?._tag).toBe("InvalidDeferredCallLimitError");
    expect(capture.limitError?.attempts).toBe(4);
    expect(capture.limitError?.message).toMatch(/pi_call.*is this gateway's own name/);
    expect(fifth).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });
});
