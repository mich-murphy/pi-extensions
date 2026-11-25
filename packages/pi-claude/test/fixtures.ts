import type {
  HookCallback,
  HookJSONOutput,
  PreToolUseHookInput,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { normalizeContext } from "@earendil-works/pi-ai";
import type {
  Context,
  Message,
  Model,
  TranscriptContext,
  AssistantMessage,
  SystemMessage,
  UserMessage,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Schema } from "effect";
import { Type } from "typebox";
import type { AgentRequest, ImageAttachment, PromptBlock } from "../agent-request";
import type { RunSdkQuery } from "../sdk/runner";

export async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];

  for await (const item of iterable) {
    items.push(item);
  }

  return items;
}

export function contextFixture(input: {
  readonly systemPrompt?: string;
  readonly messages: readonly MessageFixture[];
  readonly tools?: NonNullable<Context["tools"]>;
}): TranscriptContext {
  return normalizeContext({ ...input, messages: input.messages.map(messageFixture) });
}

export type MessageFixture =
  | (Omit<UserMessage, "timestamp"> & { readonly timestamp?: number })
  | (Omit<SystemMessage, "timestamp"> & { readonly timestamp?: number })
  | (Omit<ToolResultMessage, "timestamp"> & { readonly timestamp?: number })
  | (Pick<AssistantMessage, "role" | "content"> &
      Partial<Omit<AssistantMessage, "role" | "content">>);

function messageFixture(input: MessageFixture): Message {
  if (input.role === "assistant") {
    return {
      api: "claude",
      provider: "claude",
      model: "claude-5.5-sonnet",
      stopReason: "stop",
      timestamp: 0,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      ...input,
    };
  }

  return { timestamp: 0, ...input };
}

export function transcriptFixture(messages: readonly MessageFixture[]): TranscriptContext {
  return contextFixture({ messages });
}

export type ModelFixtureFields = {
  readonly id: string;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Model<"claude">["thinkingLevelMap"] | undefined;
};

export function modelFixture({
  id,
  reasoning = false,
  thinkingLevelMap,
}: ModelFixtureFields): Model<"claude"> {
  const thinking: Pick<Model<"claude">, "thinkingLevelMap"> = {};

  if (thinkingLevelMap !== undefined) {
    thinking.thinkingLevelMap = thinkingLevelMap;
  }

  return {
    ...thinking,
    id,
    name: id,
    api: "claude",
    provider: "claude",
    baseUrl: "agent-sdk://local-claude-code",
    reasoning,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  };
}

export const sonnet = modelFixture({ id: "claude-5.5-sonnet" });

export async function unsettled<T>(): Promise<T> {
  return Promise.withResolvers<T>().promise;
}

export function textBlock(text: string, images: readonly ImageAttachment[] = []): PromptBlock {
  return { text, images };
}

export function requestFixture(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    systemPrompt: "stable system prompt",
    promptBlocks: [textBlock("hello")],
    cacheBreakpoints: [],
    toolDescription: "stable tools",
    toolNames: new Set(["read"]),
    tools: [...(overrides.toolNames ?? ["read"])].map((name) => ({
      name,
      description: name,
      parameters: name === "read" ? Type.Object({ path: Type.String() }) : Type.Object({}),
    })),
    ...overrides,
  };
}

export type ToolUse = {
  readonly id: string;
  readonly input: unknown;
  readonly toolName?: string;
};

export async function deliverToolUse(
  hook: HookCallback,
  { id, input, toolName }: ToolUse,
): Promise<HookJSONOutput> {
  const targeted = Schema.is(
    Schema.Struct({
      name: Schema.String,
      arguments: Schema.optional(Schema.Unknown),
    }),
  )(input)
    ? input
    : undefined;

  const directName =
    toolName ?? (targeted === undefined ? "mcp__pi__read" : `mcp__pi__${targeted.name}`);

  const directInput =
    toolName === undefined && targeted !== undefined && "arguments" in targeted
      ? targeted.arguments
      : input;

  const hookInput = {
    session_id: "test-session",
    transcript_path: "/dev/null",
    cwd: "/",
    hook_event_name: "PreToolUse",
    tool_name: directName,
    tool_use_id: id,
    tool_input: directInput,
  } satisfies PreToolUseHookInput;

  return hook(hookInput, id, { signal: new AbortController().signal });
}

export async function deliverToolUses(
  hook: HookCallback,
  toolUses: readonly ToolUse[],
): Promise<void> {
  for (const toolUse of toolUses) {
    await deliverToolUse(hook, toolUse);
  }
}

export function installedHook(params: Parameters<RunSdkQuery>[0]): HookCallback {
  const hook = params.options?.hooks?.PreToolUse?.[0]?.hooks?.[0];

  if (!hook) {
    throw new Error("test setup: PreToolUse hook missing from SDK query options");
  }

  return hook;
}

export type SdkResultFields = {
  readonly is_error?: Schema.Json;
  readonly stop_reason?: Schema.Json;
  readonly terminal_reason?: Schema.Json | undefined;
  readonly subtype?: Schema.Json;
  readonly usage?: Schema.Json;
  readonly modelUsage?:
    | Schema.Json
    | Readonly<
        Record<
          string,
          {
            readonly contextWindow?: Schema.Json | undefined;
            readonly maxOutputTokens?: Schema.Json | undefined;
          }
        >
      >
    | undefined;
  readonly num_turns?: Schema.Json;
  readonly errors?: Schema.Json;
  readonly result?: Schema.Json;
};

export function resultMessage(fields: SdkResultFields = {}) {
  return { type: "result", is_error: false, stop_reason: "end_turn", ...fields };
}

export function streamEvent(event: {
  readonly type?: Schema.Json;
  readonly delta?: Schema.Json;
  readonly index?: number;
  readonly message?: Schema.Json;
  readonly usage?: Schema.Json;
  readonly content_block?: Schema.Json;
}) {
  return { type: "stream_event", event };
}

export function textDelta(text: string) {
  return streamEvent({ type: "content_block_delta", delta: { type: "text_delta", text } });
}

export function sdkPromptFixture(
  prompt: Parameters<RunSdkQuery>[0]["prompt"],
): AsyncIterable<SDKUserMessage> {
  if (Schema.is(Schema.String)(prompt)) {
    throw new TypeError("test setup: expected an async SDK prompt");
  }

  return prompt;
}

const sdkPromptBlock = Schema.Struct({
  type: Schema.Literals(["text", "image"]),
  text: Schema.optional(Schema.String),
  source: Schema.optional(
    Schema.Struct({
      type: Schema.Literal("base64"),
      data: Schema.String,
      media_type: Schema.String,
    }),
  ),
  cache_control: Schema.optional(
    Schema.Struct({
      type: Schema.Literal("ephemeral"),
      ttl: Schema.optional(Schema.Literals(["5m", "1h"])),
    }),
  ),
});

export type SdkPromptBlock = typeof sdkPromptBlock.Type;

export function sdkContentRecords(message: SDKUserMessage | undefined): SdkPromptBlock[] {
  const content = message?.message.content;

  if (!Schema.is(Schema.Array(Schema.Unknown))(content)) {
    return [];
  }

  return content.map((block) => {
    if (!Schema.is(sdkPromptBlock)(block)) {
      throw new Error("test setup: expected a text or image block in the SDK prompt");
    }

    return { ...block };
  });
}
