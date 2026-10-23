import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Tool } from "@earendil-works/pi-ai";
import { Type, validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { createDeferredCallCapture, createDeferredPiTools } from "../sdk/deferred-tools";
import { compileToolCatalog } from "../sdk/tool-catalog";
import { deliverToolUse } from "./fixtures";

const declaration = {
  name: "read",
  description: "Read fixture",
  parameters: Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
};

function expectedPiCall(
  tool: Tool,
  input: Parameters<typeof validateToolArguments>[1]["arguments"],
): object {
  try {
    const normalized: unknown = validateToolArguments(tool, {
      type: "toolCall",
      id: "corpus",
      name: tool.name,
      arguments: input,
    });
    return { name: tool.name, arguments: normalized };
  } catch {
    return { name: "pi_claude_sdk_validation_error", arguments: { error: "invalid_tool_input" } };
  }
}

describe("schema-faithful deferred tools", () => {
  test("lists the actual required input schema through the real SDK MCP transport", async () => {
    const catalog = compileToolCatalog([
      {
        ...declaration,
        parameters: Type.Object(
          {
            path: Type.String({ minLength: 1 }),
            $schema: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
      },
    ]);
    const server = createSdkMcpServer({ name: "pi", tools: [] });
    for (const tool of createDeferredPiTools(catalog)) {
      server.instance.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.inputSchema },
        tool.handler,
      );
    }
    const response = Promise.withResolvers<unknown>();
    const transport: Parameters<typeof server.instance.connect>[0] = {
      start: async () => undefined,
      close: async () => undefined,
      send: async (message) => {
        response.resolve(message);
      },
    };
    await server.instance.connect(transport);
    try {
      transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      await expect(response.promise).resolves.toMatchObject({
        result: {
          tools: [
            {
              name: "read",
              inputSchema: {
                type: "object",
                required: ["path"],
                properties: { path: { type: "string", minLength: 1 }, $schema: { type: "string" } },
                additionalProperties: false,
              },
            },
          ],
        },
      });
    } finally {
      await server.instance.close();
    }
  });

  test.each([
    { path: "fixture" },
    {},
    { path: "" },
    { path: [] },
    { path: "fixture", extra: true },
  ])("agrees with Pi on canonical JSON input %j", (input) => {
    const [selected] = compileToolCatalog([declaration]);
    expect(selected).toBeDefined();
    let valid = true;
    try {
      validateToolArguments(declaration, {
        type: "toolCall",
        id: "fixture",
        name: "read",
        arguments: input,
      });
    } catch {
      valid = false;
    }
    expect(selected?.schema.safeParse(input).success).toBe(valid);
  });

  test("retains each valid sibling exactly once and rejects malformed selected-tool input", async () => {
    const capture = createDeferredCallCapture(compileToolCatalog([declaration]));
    for (const id of ["first", "first", "second"]) {
      await deliverToolUse(capture.hook, { id, toolName: "mcp__pi__read", input: { path: id } });
    }
    await deliverToolUse(capture.hook, { id: "bad", toolName: "mcp__pi__read", input: {} });
    expect(capture.calls).toStrictEqual([
      { id: "first", name: "read", arguments: { path: "first" } },
      { id: "second", name: "read", arguments: { path: "second" } },
      {
        id: "bad",
        name: "pi_claude_sdk_validation_error",
        arguments: { error: "invalid_tool_input" },
      },
    ]);
  });

  test("maps punctuation, long and unicode names deterministically without collisions", () => {
    const names = ["read", "a.b", "a_b", "日本語", "x".repeat(100), "pi_reserved"];
    const tools = names.map((name) => ({ ...declaration, name }));
    const catalog = compileToolCatalog(tools);
    expect(catalog.map((entry) => entry.declaration.name)).toStrictEqual(names);
    expect(new Set(catalog.map((entry) => entry.sdkName)).size).toBe(names.length);
    expect(catalog.every((entry) => /^[a-zA-Z0-9_-]{1,64}$/u.test(entry.sdkName))).toBe(true);
    expect(compileToolCatalog(tools).map((entry) => entry.sdkName)).toStrictEqual(
      catalog.map((entry) => entry.sdkName),
    );
    expect(() => compileToolCatalog([declaration, declaration])).toThrow("naming");
  });

  test.each(["oneOf", "$ref", "not", "patternProperties", "format", "default", "secretProperty"])(
    "fails before advertising unsupported keyword %s",
    (keyword) => {
      expect(() =>
        compileToolCatalog([
          { ...declaration, parameters: { ...declaration.parameters, [keyword]: {} } },
        ]),
      ).toThrow("schema");
    },
  );

  test("Pi normalization is authoritative, including numeric strings and optional nulls", async () => {
    const tools = [
      {
        name: "normalize",
        description: "normalize",
        parameters: Type.Object({
          n: Type.Number(),
          s: Type.Optional(Type.String()),
          i: Type.Optional(Type.Integer()),
        }),
      },
    ];
    const capture = createDeferredCallCapture(compileToolCatalog(tools));
    await deliverToolUse(capture.hook, {
      id: "normalized",
      toolName: "mcp__pi__normalize",
      input: { n: "3", s: null, i: 2 },
    });
    expect(capture.calls).toStrictEqual([
      { id: "normalized", name: "normalize", arguments: { n: 3, i: 2 } },
    ]);
    expect(compileToolCatalog(tools)[0]?.schema.safeParse({ n: 3, i: 2.5 }).success).toBe(false);
  });

  test("unhooked valid input is a lifecycle failure, not invalid input", async () => {
    const capture = createDeferredCallCapture(compileToolCatalog([declaration]));
    await capture.batchHook(
      {
        hook_event_name: "PostToolBatch",
        session_id: "fixture",
        transcript_path: "/dev/null",
        cwd: "/",
        tool_calls: [
          { tool_use_id: "unhooked", tool_name: "mcp__pi__read", tool_input: { path: "fixture" } },
        ],
      },
      undefined,
      { signal: new AbortController().signal },
    );
    expect(capture.invalidGatewayCalls).toBe(0);
    expect(capture.uncapturedBatchCalls).toBe(1);
    expect(capture.calls).toStrictEqual([
      {
        id: "unhooked",
        name: "pi_claude_sdk_validation_error",
        arguments: { error: "uncaptured_tool_batch" },
      },
    ]);
  });

  test("preserves literal object data instead of normalizing it as a schema", () => {
    expect(() =>
      compileToolCatalog([
        {
          ...declaration,
          parameters: Type.Object({
            data: {
              const: { $schema: "literal", type: "integer", properties: { $schema: "data" } },
            },
          }),
        },
      ]),
    ).toThrow("schema");
  });

  test.each([-1, 0, 2, Number.MAX_SAFE_INTEGER + 1])(
    "ordinary integer %s preserves acceptance",
    (i) => {
      const tool = {
        name: "integer",
        description: "integer",
        parameters: Type.Object({ i: Type.Integer() }),
      };
      const [compiled] = compileToolCatalog([tool]);
      expect(compiled?.schema.safeParse({ i }).success).toBe(true);
      expect(
        validateToolArguments(tool, {
          type: "toolCall",
          id: "integer",
          name: "integer",
          arguments: { i },
        }),
      ).toStrictEqual({ i });
    },
  );

  test.each([
    { count: 3, mode: "a", children: [{ id: "first" }] },
    { count: "3", mode: "b", children: [{ id: "first" }], note: null },
    { count: 0, mode: "a", children: [], note: "note", extra: { kept: true } },
    { count: -1, mode: "a", children: [] },
    { count: 1.5, mode: "a", children: [] },
    { count: 1, mode: "c", children: [] },
    { count: 1, mode: "a", children: [{}] },
    { count: 1, mode: "a", children: "not-an-array" },
    { count: "invalid", mode: "a", children: [] },
    { mode: "a", children: [] },
  ])("Pi/SDK capture parity retains normalized bounded corpus %j", async (input) => {
    const tool = {
      name: "corpus",
      description: "corpus",
      parameters: Type.Object({
        count: Type.Integer({ minimum: 0 }),
        mode: Type.Union([Type.Literal("a"), Type.Literal("b")]),
        children: Type.Array(Type.Object({ id: Type.String({ minLength: 1 }) })),
        note: Type.Optional(Type.String()),
      }),
    };
    const expected = expectedPiCall(tool, input);
    const capture = createDeferredCallCapture(compileToolCatalog([tool]));
    await deliverToolUse(capture.hook, { id: "corpus", toolName: "mcp__pi__corpus", input });
    const [call] = capture.calls;
    expect(call).toMatchObject(expected);
  });

  test("mapped SDK names round-trip to exact Pi names during capture", async () => {
    const names = ["read", "a.b", "a_b", "日本語", "x".repeat(100), "pi_reserved"];
    const catalog = compileToolCatalog(names.map((name) => ({ ...declaration, name })));
    const capture = createDeferredCallCapture(catalog);
    for (const tool of catalog) {
      await deliverToolUse(capture.hook, {
        id: tool.sdkName,
        toolName: tool.sdkName,
        input: { path: "fixture" },
      });
    }
    expect(capture.calls.map((call) => call.name)).toStrictEqual(names);
    expect(() => compileToolCatalog([{ ...declaration, name: "" }])).toThrow("naming");
  });

  test("the fallback never executes Pi and remains a failure", async () => {
    let fallbacks = 0;
    const [tool] = createDeferredPiTools(compileToolCatalog([declaration]), () => {
      fallbacks += 1;
    });
    await expect(tool?.handler()).resolves.toMatchObject({ isError: true });
    expect(fallbacks).toBe(1);
  });
});
