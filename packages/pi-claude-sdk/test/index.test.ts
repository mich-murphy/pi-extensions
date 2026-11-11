import type {
  ToolCallEvent,
  ProviderConfig,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { assert, describe, expect, test } from "vitest";
import type { ClaudeHandlers, ClaudeEvents } from "../index";
import registerClaudeSdkProvider, { USAGE_LIMIT_CHANNEL, usageLimitPublisher } from "../index";

function loadExtension() {
  const handlers: Partial<ClaudeHandlers> = {};
  const providers = new Map<string, ProviderConfig>();
  const piMock = {
    registerCommand: () => undefined,
    registerTool: () => undefined,
    on: <K extends keyof ClaudeHandlers>(name: K, handler: ClaudeHandlers[K]) => {
      handlers[name] = handler;
    },
    registerProvider: (name: string, config: ProviderConfig) => {
      providers.set(name, config);
    },
    events: { emit: () => undefined },
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
  test("registers every model without the routing fields Pi does not know about", () => {
    const provider = loadExtension().providers.get("claude-sdk");

    expect(provider?.models?.map((model) => model.id)).toStrictEqual([
      "claude-5.5-sonnet",
      "claude-5.5-opus",
      "claude-5.2-fable",
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

describe("recovery hook overhead", () => {
  test("does not read history for ordinary messages or successful reserved results", () => {
    const { emit } = loadExtension();
    let reads = 0;
    const ctx = {
      hasUI: false,
      ui: { notify: () => undefined },
      sessionManager: {
        getBranch: () => {
          reads++;
          return [];
        },
      },
    };
    void emit("message_end", { message: { role: "user", content: "hello", timestamp: 0 } }, ctx);
    void emit(
      "message_end",
      {
        message: {
          role: "toolResult",
          toolCallId: "normal",
          toolName: "read",
          content: [],
          isError: true,
          timestamp: 0,
        },
      },
      ctx,
    );
    void emit(
      "message_end",
      {
        message: {
          role: "toolResult",
          toolCallId: "reserved",
          toolName: "pi_claude_sdk_validation_error",
          content: [],
          isError: false,
          timestamp: 0,
        },
      },
      ctx,
    );
    expect(reads).toBe(0);
  });

  test("scratchpad guidance remains identical across prompt rebuilds", () => {
    const { emit } = loadExtension();
    const sections: Record<string, string> = {};
    void emit("before_agent_start", { systemPromptOptions: { sections } });
    const before = { ...sections };
    void emit("before_agent_start", { systemPromptOptions: { sections } });
    expect(sections).toStrictEqual(before);
  });
});

describe("usage limit notices", () => {
  test("publishes the reset time on the shared usage-limit channel", () => {
    const emitted: { channel: string; data: unknown }[] = [];
    const publish = usageLimitPublisher({
      emit: (channel, data) => {
        emitted.push({ channel, data });
      },
    });

    publish({ resetsAt: 1_792_548_000_000 });

    expect(emitted).toStrictEqual([
      {
        channel: USAGE_LIMIT_CHANNEL,
        data: { provider: "claude-sdk", resetsAt: 1_792_548_000_000 },
      },
    ]);
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
      "claude-sdk-scratchpad": expect.stringContaining("native session IDs") as unknown,
    });
  });

  test("blocks a bash command that dumps a discovered executable, and nothing else", () => {
    const { emit } = loadExtension();
    const refusal: unknown = expect.stringContaining(
      "Blocked by executable-output guard: executable data may be printed, or this shell syntax cannot be inspected safely.",
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
