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
  return {
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
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
  const targeted =
    typeof input === "object" &&
    input !== null &&
    "name" in input &&
    typeof input.name === "string";
  const directName = toolName ?? (targeted ? `mcp__pi__${String(input.name)}` : "mcp__pi__read");
  const directInput =
    toolName === undefined && targeted && "arguments" in input ? input.arguments : input;
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

export function resultMessage(
  fields: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { type: "result", is_error: false, stop_reason: "end_turn", ...fields };
}

export function streamEvent(event: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { type: "stream_event", event };
}

export function textDelta(text: string): Record<string, unknown> {
  return streamEvent({ type: "content_block_delta", delta: { type: "text_delta", text } });
}

export function sdkPromptFixture(
  prompt: Parameters<RunSdkQuery>[0]["prompt"],
): AsyncIterable<SDKUserMessage> {
  if (typeof prompt === "string") {
    throw new TypeError("test setup: expected an async SDK prompt");
  }
  return prompt;
}

export function sdkContentRecords(message: SDKUserMessage | undefined): Record<string, unknown>[] {
  const content = message?.message.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((block): Record<string, unknown> => ({ ...block }));
}
