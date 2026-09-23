import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import registerClaudeSdkProvider from "../index";

type Handler = (event: unknown, ctx: unknown) => unknown;

function loadExtension() {
  const registrations: string[] = [];
  const handlers = new Map<string, Handler>();
  const providers = new Map<string, { models: ReadonlyArray<Record<string, unknown>> }>();
  const piMock = {
    registerCommand: (name: string) => registrations.push(`command:${name}`),
    on: (name: string, handler: Handler) => {
      registrations.push(`event:${name}`);
      handlers.set(name, handler);
    },
    registerProvider: (name: string, config: { models: [] }) => {
      registrations.push(`provider:${name}`);
      providers.set(name, config);
    },
  };
  // SAFETY: The extension only calls the three registration methods the mock implements.
  registerClaudeSdkProvider(piMock as unknown as ExtensionAPI);
  const emit = (name: string, event: unknown, ctx: unknown = { hasUI: false }) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`test setup: no ${name} handler registered`);
    return handler(event, ctx);
  };
  return { registrations, providers, emit };
}

const binaryOutput = [{ type: "text", text: "\u0000payload".repeat(5_000) }];

describe("extension entry point", () => {
  test("registers commands, safety hooks, and the provider", () => {
    expect(loadExtension().registrations).toEqual([
      "command:claude-sdk-status",
      "command:claude-sdk-usage",
      "event:before_agent_start",
      "event:tool_call",
      "event:tool_result",
      "event:context",
      "provider:claude-sdk",
    ]);
  });

  test("registers every model without the routing fields Pi does not know about", () => {
    const provider = loadExtension().providers.get("claude-sdk");

    expect(provider?.models.map((model) => model.id)).toEqual([
      "claude-5-sonnet",
      "claude-5.5-opus",
      "claude-5.1-fable",
      "claude-4.5-haiku",
    ]);
    for (const model of provider?.models ?? []) {
      expect(model).not.toHaveProperty("sdkModel");
      expect(model).not.toHaveProperty("canonicalModel");
    }
  });
});

describe("bash output safety hooks", () => {
  test("appends the bash output rule to the system prompt", () => {
    const result = loadExtension().emit("before_agent_start", { systemPrompt: "Base prompt." });

    expect(result).toEqual({
      systemPrompt: expect.stringMatching(/^Base prompt\.\n\nBash output safety: never cat/),
    });
  });

  test("blocks a bash command that dumps a discovered executable, and nothing else", () => {
    const { emit } = loadExtension();
    const bash = (command: string) => ({ type: "tool_call", toolName: "bash", input: { command } });

    expect(emit("tool_call", bash("cat $(which node)"))).toMatchObject({
      block: true,
      reason: expect.stringContaining("Refusing to pipe a discovered executable through cat"),
    });
    expect(emit("tool_call", bash("cat package.json"))).toBeUndefined();
    expect(
      emit("tool_call", { type: "tool_call", toolName: "read", input: { path: "$(which cat)" } }),
    ).toBeUndefined();
  });

  test("quarantines suspicious bash results and warns when a UI is attached", () => {
    const { emit } = loadExtension();
    const notifications: unknown[][] = [];
    const ui = { hasUI: true, ui: { notify: (...args: unknown[]) => notifications.push(args) } };

    const result = emit("tool_result", { toolName: "bash", content: binaryOutput }, ui);

    expect(result).toEqual({
      content: [{ type: "text", text: expect.stringContaining("Binary-like bash output") }],
    });
    expect(notifications).toEqual([
      [expect.stringContaining("Quarantined binary-like"), "warning"],
    ]);
    expect(emit("tool_result", { toolName: "bash", content: binaryOutput })).toEqual(result);
  });

  test("leaves clean bash results and other tools' results untouched", () => {
    const { emit } = loadExtension();

    expect(
      emit("tool_result", { toolName: "bash", content: [{ type: "text", text: "ok" }] }),
    ).toBeUndefined();
    expect(emit("tool_result", { toolName: "read", content: binaryOutput })).toBeUndefined();
  });

  test("quarantines suspicious bash results already recorded in the context", () => {
    const user = { role: "user", content: "inspect it", timestamp: 0 };
    const recorded = {
      role: "toolResult",
      toolName: "bash",
      toolCallId: "c",
      content: binaryOutput,
    };

    const result = loadExtension().emit("context", { messages: [user, recorded] });

    expect(result).toEqual({
      messages: [
        user,
        {
          ...recorded,
          content: [{ type: "text", text: expect.stringContaining("Binary-like bash output") }],
        },
      ],
    });
  });
});
