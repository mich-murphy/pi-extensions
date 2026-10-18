import type {
  ToolCallEvent,
  ProviderConfig,
  ToolResultEvent,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { assert, describe, expect, test } from "vitest";
import noSleep from "../../pi-caffeinate/index";
import skillToggle from "../../pi-skill-toggle/index";
import vimMode from "../../pi-vim/index";
import webToolsExtension from "../../pi-web-tools/index";
import type { ClaudeHandlers, ClaudeEvents } from "../index";
import registerClaudeSdkProvider from "../index";

function loadExtension() {
  const handlers: Partial<ClaudeHandlers> = {};
  const providers = new Map<string, ProviderConfig>();
  const piMock = {
    registerCommand: () => undefined,
    on: <K extends keyof ClaudeHandlers>(name: K, handler: ClaudeHandlers[K]) => {
      handlers[name] = handler;
    },
    registerProvider: (name: string, config: ProviderConfig) => {
      providers.set(name, config);
    },
  };
  registerClaudeSdkProvider(piMock);
  const noUI = { hasUI: false, ui: { notify: () => undefined } };
  const emit = <K extends keyof ClaudeEvents>(
    name: K,
    event: ClaudeEvents[K],
    ctx: Parameters<ClaudeHandlers[K]>[1] = noUI,
  ): ReturnType<ClaudeHandlers[keyof ClaudeHandlers]> => {
    const handler = handlers[name];
    if (!handler) {
      throw new Error(`test setup: no ${name} handler registered`);
    }
    return handler(event, ctx);
  };
  return { providers, emit };
}

const binaryOutput: Pick<ToolResultEvent, "content">["content"] = [
  { type: "text", text: "\u0000payload".repeat(5000) },
];
const quarantineNotice: unknown = expect.stringContaining("Binary-like bash output");

function bashCall(command: string): ToolCallEvent {
  return { type: "tool_call", toolCallId: "test", toolName: "bash", input: { command } };
}

describe("extension entry point", () => {
  test("all package factories accept the installed Pi extension contract", () => {
    expect(registerClaudeSdkProvider satisfies ExtensionFactory).toBeTypeOf("function");
    expect(noSleep satisfies ExtensionFactory).toBeTypeOf("function");
    expect(skillToggle satisfies ExtensionFactory).toBeTypeOf("function");
    expect(vimMode satisfies ExtensionFactory).toBeTypeOf("function");
    expect(webToolsExtension satisfies ExtensionFactory).toBeTypeOf("function");
  });

  test("registers every model without the routing fields Pi does not know about", () => {
    const provider = loadExtension().providers.get("claude-sdk");

    expect(provider?.models?.map((model) => model.id)).toStrictEqual([
      "claude-5.5-sonnet",
      "claude-5.5-opus",
      "claude-5.1-fable",
      "claude-5.5-haiku",
      "claude-4.5-haiku",
    ]);
    assert(provider?.models !== undefined, "test setup: provider not registered");
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
      emit("tool_call", {
        type: "tool_call",
        toolCallId: "test",
        toolName: "read",
        input: { path: "$(which cat)" },
      }),
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
    const user = { role: "user" as const, content: "inspect it", timestamp: 0 };
    const recorded = {
      role: "toolResult" as const,
      timestamp: 0,
      isError: false,
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
