import type {
  HookCallback,
  HookJSONOutput,
  PreToolUseHookInput,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Type, normalizeContext } from "@earendil-works/pi-ai";
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
import type { AgentRequest, ImageAttachment, PromptBlock } from "../agent-request";
import type { RunSdkQuery } from "../sdk/runner";

/**
 * Collect every value of an async iterable.
 *
 * @param iterable - Stream under test.
 * @returns All yielded values in order.
 */
export async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

/**
 * Build the provider-facing context for a prompt, tools, and messages.
 *
 * Normalization is Pi's own, so the fixture folds the prompt and tools into a
 * leading system message exactly as a real turn does.
 *
 * @param input - Prompt and message fields varied by the test.
 * @returns The fixture as a normalized provider context.
 */
export function contextFixture(input: {
  readonly systemPrompt?: string;
  readonly messages: readonly MessageFixture[];
  readonly tools?: NonNullable<Context["tools"]>;
}): TranscriptContext {
  return normalizeContext({ ...input, messages: input.messages.map(messageFixture) });
}

/** Message fields varied by tests; constructors supply Pi's bookkeeping fields. */
export type MessageFixture =
  | (Omit<UserMessage, "timestamp"> & { readonly timestamp?: number })
  | (Omit<SystemMessage, "timestamp"> & { readonly timestamp?: number })
  | (Omit<ToolResultMessage, "timestamp"> & { readonly timestamp?: number })
  | (Pick<AssistantMessage, "role" | "content"> &
      Partial<Omit<AssistantMessage, "role" | "content">>);

function messageFixture(input: MessageFixture): Message {
  if (input.role === "assistant") {
    return {
      api: "claude-sdk",
      provider: "claude-sdk",
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

/**
 * Build a provider-facing context from transcript messages verbatim.
 *
 * Use this for transcripts whose system messages are the subject of the test,
 * such as a mid-conversation prompt or tool change; {@link contextFixture}
 * covers the ordinary case.
 *
 * @param messages - Message fields, including system messages, to complete and normalize.
 * @returns The messages as a normalized provider context.
 */
export function transcriptFixture(messages: readonly MessageFixture[]): TranscriptContext {
  return contextFixture({ messages });
}

/** Fields a test varies on an otherwise complete Claude SDK model. */
export type ModelFixtureFields = {
  /** Pi-facing model ID. */
  readonly id: string;
  /** Whether the model accepts effort-based reasoning. */
  readonly reasoning?: boolean;
  /** Pi thinking levels the model maps; omitted when it uses Pi's defaults. */
  readonly thinkingLevelMap?: Model<"claude-sdk">["thinkingLevelMap"] | undefined;
};

/**
 * Build a complete Claude SDK model with subscription pricing.
 *
 * @param fields - The model ID and, when it matters, its reasoning support and thinking levels.
 * @returns The Claude SDK model.
 */
export function modelFixture({
  id,
  reasoning = false,
  thinkingLevelMap,
}: ModelFixtureFields): Model<"claude-sdk"> {
  return {
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    id,
    name: id,
    api: "claude-sdk",
    provider: "claude-sdk",
    baseUrl: "agent-sdk://local-claude-code",
    reasoning,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  };
}

/** The registered Sonnet model with subscription pricing, as most tests need it. */
export const sonnet = modelFixture({ id: "claude-5.5-sonnet" });

/**
 * Build a promise that never settles, standing in for an SDK call that hangs.
 *
 * @template T - Value type the hanging call would have produced.
 * @returns A promise that neither resolves nor rejects.
 */
export async function unsettled<T>(): Promise<T> {
  return Promise.withResolvers<T>().promise;
}

/**
 * Build a prompt block.
 *
 * @param text - Block text.
 * @param images - Images expanded after the text.
 * @returns The prompt block.
 */
export function textBlock(text: string, images: readonly ImageAttachment[] = []): PromptBlock {
  return { text, images };
}

/**
 * Build a runner request, overriding only what a test cares about.
 *
 * @param overrides - Fields that differ from the single-block default request.
 * @returns A complete agent request.
 */
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

/** One tool use the model requested, as the SDK reports it to a `PreToolUse` hook. */
export type ToolUse = {
  /** SDK tool-use identifier. */
  readonly id: string;
  /** Selected-tool parameters, or a test target with name and arguments. */
  readonly input: unknown;
  /** Explicit SDK tool name; otherwise derived from the test target. */
  readonly toolName?: string;
};

/**
 * Deliver one `PreToolUse` event to a hook the way the SDK does.
 *
 * @param hook - Hook under test.
 * @param toolUse - The tool use to report.
 * @returns The hook's permission output.
 */
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

/**
 * Deliver tool uses to a hook one at a time, in order.
 *
 * @param hook - Hook under test.
 * @param toolUses - Tool uses in arrival order.
 */
export async function deliverToolUses(
  hook: HookCallback,
  toolUses: readonly ToolUse[],
): Promise<void> {
  for (const toolUse of toolUses) {
    await deliverToolUse(hook, toolUse);
  }
}

/**
 * Read the `PreToolUse` hook the runner installed on an SDK query.
 *
 * @param params - Parameters captured from the fake SDK query.
 * @returns The installed hook.
 */
export function installedHook(params: Parameters<RunSdkQuery>[0]): HookCallback {
  const hook = params.options?.hooks?.PreToolUse?.[0]?.hooks?.[0];
  if (!hook) {
    throw new Error("test setup: PreToolUse hook missing from SDK query options");
  }
  return hook;
}

/**
 * Build a terminal SDK result message.
 *
 * @param fields - Fields that differ from a clean `end_turn` result.
 * @returns The SDK result message.
 */
export function resultMessage(
  fields: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { type: "result", is_error: false, stop_reason: "end_turn", ...fields };
}

/**
 * Build an SDK partial-message stream event.
 *
 * @param event - Anthropic stream event payload.
 * @returns The SDK stream message.
 */
export function streamEvent(event: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { type: "stream_event", event };
}

/**
 * Build the SDK stream message for one text delta.
 *
 * @param text - Delta text.
 * @returns The SDK stream message.
 */
export function textDelta(text: string): Record<string, unknown> {
  return streamEvent({ type: "content_block_delta", delta: { type: "text_delta", text } });
}

/**
 * Narrow the SDK query prompt to the streaming-input mode configured by the runner.
 *
 * @param prompt - Prompt captured from SDK query parameters.
 * @returns The streaming SDK user-message input.
 */
export function sdkPromptFixture(
  prompt: Parameters<RunSdkQuery>[0]["prompt"],
): AsyncIterable<SDKUserMessage> {
  if (typeof prompt === "string") {
    throw new TypeError("test setup: expected an async SDK prompt");
  }
  return prompt;
}

/**
 * Expose SDK content blocks as records for metadata-only assertions.
 *
 * @param message - SDK user message built by the prompt adapter.
 * @returns Content blocks as unknown-valued records.
 */
export function sdkContentRecords(message: SDKUserMessage | undefined): Record<string, unknown>[] {
  const content = message?.message.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((block): Record<string, unknown> => ({ ...block }));
}
