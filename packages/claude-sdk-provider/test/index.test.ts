import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assert, describe, expect, test } from "vitest";
import registerClaudeSdkProvider from "../index";

type Handler = (event: unknown, ctx: unknown) => unknown;

type ProviderRegistration = { readonly models: readonly Readonly<Record<string, unknown>>[] };

function loadExtension() {
  const registrations: string[] = [];
  const handlers = new Map<string, Handler>();
  const providers = new Map<string, ProviderRegistration>();
  const piMock = {
    registerCommand: (name: string) => {
      registrations.push(`command:${name}`);
    },
    on: (name: string, handler: Handler) => {
      registrations.push(`event:${name}`);
      handlers.set(name, handler);
    },
    registerProvider: (name: string, config: ProviderRegistration) => {
      registrations.push(`provider:${name}`);
      providers.set(name, config);
    },
  };
  registerClaudeSdkProvider(piMock as unknown as ExtensionAPI);
  const noUI = { hasUI: false };
  const emit = (name: string, event: unknown, ctx: unknown = noUI) => {
    const handler = handlers.get(name);
    if (!handler) {
      throw new Error(`test setup: no ${name} handler registered`);
    }
    return handler(event, ctx);
  };
  return { registrations, providers, emit };
}

const binaryOutput = [{ type: "text", text: "\u0000payload".repeat(5000) }];
const quarantineNotice: unknown = expect.stringContaining("Binary-like bash output");

function bashCall(command: string) {
  return { type: "tool_call", toolName: "bash", input: { command } };
}

describe("extension entry point", () => {
  test("registers commands, safety hooks, and the provider", () => {
    expect(loadExtension().registrations).toStrictEqual([
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

    expect(provider?.models.map((model) => model.id)).toStrictEqual([
      "claude-5.5-sonnet",
      "claude-5.5-opus",
      "claude-5.1-fable",
      "claude-5.5-haiku",
      "claude-4.5-haiku",
    ]);
    assert(provider !== undefined, "test setup: provider not registered");
    for (const model of provider.models) {
      expect(model).not.toHaveProperty("sdkModel");
      expect(model).not.toHaveProperty("canonicalModel");
    }
  });
});

describe("bash output safety hooks", () => {
  test("adds the bash output rule as a section and keeps other extensions' sections", () => {
    const sections: Record<string, string> = { "mm-mode": "Router." };
    const result = loadExtension().emit("before_agent_start", {
      systemPrompt: "Base prompt.",
      systemPromptOptions: { sections },
    });

    const bashRule: unknown = expect.stringMatching(/^Bash output safety: never cat/u);
    expect(result).toBeUndefined();
    expect(sections).toStrictEqual({
      "mm-mode": "Router.",
      "bash-output-safety": bashRule,
    });
  });

  test("blocks a bash command that dumps a discovered executable, and nothing else", () => {
    const { emit } = loadExtension();
    const refusal: unknown = expect.stringContaining(
      "Refusing to pipe a discovered executable through cat",
    );

    expect(emit("tool_call", bashCall("cat $(which node)"))).toMatchObject({
      block: true,
      reason: refusal,
    });
    expect(emit("tool_call", bashCall("cat package.json"))).toBeUndefined();
    expect(
      emit("tool_call", { type: "tool_call", toolName: "read", input: { path: "$(which cat)" } }),
    ).toBeUndefined();
  });

  test("quarantines suspicious bash results and warns when a UI is attached", () => {
    const { emit } = loadExtension();
    const notifications: (readonly unknown[])[] = [];
    const ui = {
      hasUI: true,
      ui: {
        notify: (...args: readonly unknown[]) => {
          notifications.push(args);
        },
      },
    };

    const result = emit("tool_result", { toolName: "bash", content: binaryOutput }, ui);

    expect(result).toStrictEqual({ content: [{ type: "text", text: quarantineNotice }] });
    const warning: unknown = expect.stringContaining("Quarantined binary-like");
    expect(notifications).toStrictEqual([[warning, "warning"]]);
    expect(emit("tool_result", { toolName: "bash", content: binaryOutput })).toStrictEqual(result);
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

    expect(result).toStrictEqual({
      messages: [user, { ...recorded, content: [{ type: "text", text: quarantineNotice }] }],
    });
  });
});
