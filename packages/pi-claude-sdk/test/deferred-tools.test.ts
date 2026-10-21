import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, expect, test } from "vitest";
import { createDeferredCallCapture, createDeferredPiCallTool } from "../sdk/deferred-tools";
import { deliverToolUse, deliverToolUses } from "./fixtures";

function captureFor(...toolNames: readonly string[]) {
  return { capture: createDeferredCallCapture(new Set(toolNames)) };
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

  test("hands unexpected SDK tools to Pi as nonexecuting correction calls", async () => {
    const { capture } = captureFor("read");
    const output = await deliverToolUse(capture.hook, { id: "bad", toolName: "Bash", input: {} });
    expect(output).toMatchObject({ hookSpecificOutput: { permissionDecision: "defer" } });
    expect(capture.calls).toMatchObject([
      {
        id: "bad",
        name: "pi_claude_sdk_validation_error",
        arguments: { error: "unexpected_sdk_tool" },
      },
    ]);
    expect(capture.unexpectedToolCalls).toBe(1);
    expect(capture.hookDeniedCalls).toBe(0);
  });

  test("preserves JSON values and backslash strings without rewriting shell escapes", async () => {
    const { capture } = captureFor("bash");
    const argumentsObject = {
      command: String.raw`find . -type f \( -name '*.json' -o -name '*.ts' \) | head -20`,
      nested: { list: [null, true, 12.5, { path: String.raw`C:\tmp\fixture` }] },
    };

    const output = await deliverToolUse(capture.hook, {
      id: "backslashes",
      input: { name: "bash", arguments: argumentsObject },
    });

    expect(output).toMatchObject({ hookSpecificOutput: { permissionDecision: "defer" } });
    expect(capture.calls).toStrictEqual([
      { id: "backslashes", name: "bash", arguments: argumentsObject },
    ]);
    expect(capture.hookDeniedCalls).toBe(0);
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
    expect(capture.hookDeniedCalls).toBe(0);
  });

  test("notifies the runner when the SDK executes the fallback so it can abort hidden retries", async () => {
    let fallbacks = 0;
    const gateway = createDeferredPiCallTool("available tools", () => {
      fallbacks += 1;
    });

    const result = await gateway.handler({ name: "read", arguments: {} }, undefined);

    expect(fallbacks).toBe(1);
    expect(result.isError).toBe(true);
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
  ])("defers a nonexecuting correction for %s", async (_case, { toolNames, toolInput }) => {
    const { capture } = captureFor(...toolNames);

    const output = await deliverToolUse(capture.hook, { id: "toolu_bad", input: toolInput });

    expect(output).toMatchObject({ hookSpecificOutput: { permissionDecision: "defer" } });
    expect(capture.calls).toMatchObject([
      {
        id: "toolu_bad",
        name: "pi_claude_sdk_validation_error",
        arguments: { error: "invalid_gateway_input" },
      },
    ]);
  });
});

// Real SDK MCP server only: no query(), CLI process, prompt, network or credentials.
describe("deferred gateway at the offline SDK MCP boundary", () => {
  test("lists the Zod JSON schema and validates escaped/nested arguments without rewriting them", async () => {
    const gateway = createDeferredPiCallTool("offline test catalog");
    const handlerInputs: unknown[] = [];
    const observedGateway: typeof gateway = {
      ...gateway,
      handler: async (input, extra) => {
        handlerInputs.push(input);
        return gateway.handler(input, extra);
      },
    };
    const server = createSdkMcpServer({ name: "pi", tools: [observedGateway] });
    let receive: ((message: unknown) => void) | undefined;
    const transport: Parameters<typeof server.instance.connect>[0] = {
      start: async () => {
        // This transport is entirely in-process; there is nothing to start.
      },
      close: async () => {
        receive = undefined;
      },
      send: async (message) => {
        receive?.(message);
      },
    };
    let id = 0;
    const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      const response = Promise.withResolvers<unknown>();
      receive = response.resolve;
      transport.onmessage?.({ jsonrpc: "2.0", id: ++id, method, params });
      return response.promise;
    };

    await server.instance.connect(transport);
    try {
      const listed = await request("tools/list", {});
      expect(listed).toMatchObject({
        result: {
          tools: [
            {
              name: "pi_call",
              inputSchema: {
                type: "object",
                required: ["name", "arguments"],
                properties: {
                  name: { type: "string" },
                  arguments: {
                    type: "object",
                    additionalProperties: { $ref: expect.any(String) as unknown },
                  },
                },
                definitions: {
                  __schema0: { anyOf: expect.arrayContaining([{ type: "string" }]) as unknown },
                },
              },
            },
          ],
        },
      });

      const input = {
        name: "bash",
        arguments: {
          command: String.raw`find . -type f \( -name '*.json' -o -name '*.ts' \) | head -20`,
          nested: { values: [null, false, 0, { path: String.raw`C:\tmp\fixture` }] },
        },
      };
      const called = await request("tools/call", { name: "pi_call", arguments: input });
      // The schema accepted the input. Production's fail-closed handler, not
      // an MCP validation error, generated this result. No Pi tool was executed.
      expect(handlerInputs).toStrictEqual([input]);
      expect(called).toMatchObject({
        result: {
          isError: true,
          content: [{ type: "text", text: expect.stringContaining("not honored") as unknown }],
        },
      });

      const invalid = await request("tools/call", {
        name: "pi_call",
        arguments: { name: "bash", arguments: [] },
      });
      expect(invalid).toMatchObject({
        result: {
          isError: true,
          content: [
            { type: "text", text: expect.stringContaining("Input validation error") as unknown },
          ],
        },
      });
      expect(handlerInputs).toStrictEqual([input]);
    } finally {
      await server.instance.close();
    }
  });
});
