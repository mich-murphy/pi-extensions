import type { HookCallback, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type Context,
  type Model,
  normalizeContext,
  type TranscriptContext,
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
  for await (const item of iterable) items.push(item);
  return items;
}

/**
 * Build the provider-facing context for a prompt, tools, and messages.
 *
 * Normalization is Pi's own, so the fixture folds the prompt and tools into a
 * leading system message exactly as a real turn does.
 *
 * @param input - Deliberately partial framework context fixture.
 * @returns The fixture as a normalized provider context.
 */
export function contextFixture(input: unknown): TranscriptContext {
  // SAFETY: Adapter tests intentionally omit framework-owned timestamps and metadata that the provider never reads. Each test supplies systemPrompt, messages, and tools for the behavior under test.
  return normalizeContext(input as Context);
}

/**
 * Build a provider-facing context from transcript messages verbatim.
 *
 * Use this for transcripts whose system messages are the subject of the test,
 * such as a mid-conversation prompt or tool change; {@link contextFixture}
 * covers the ordinary case.
 *
 * @param messages - Deliberately partial transcript messages, system messages included.
 * @returns The messages as a normalized provider context.
 */
export function transcriptFixture(messages: ReadonlyArray<unknown>): TranscriptContext {
  // SAFETY: Only normalizeContext() can brand a TranscriptContext, and it would prepend a second system message to a transcript that already declares its own. These tests supply the transcript Pi would have produced.
  return { messages } as unknown as TranscriptContext;
}

/**
 * Build the minimal Claude SDK model needed by provider adapter tests.
 *
 * @param input - Deliberately partial model fixture.
 * @returns The fixture as a Claude SDK model.
 */
export function modelFixture(input: unknown): Model<"claude-sdk"> {
  // SAFETY: Runner tests use only api, provider, id, reasoning, and optional cost fields. Pi normally adds the remaining registry-owned model metadata.
  return input as Model<"claude-sdk">;
}

/** The registered Sonnet model with subscription pricing, as most tests need it. */
export const sonnet = modelFixture({
  api: "claude-sdk",
  provider: "claude-sdk",
  id: "claude-5-sonnet",
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

/**
 * Build a prompt block.
 *
 * @param text - Block text.
 * @param images - Images expanded after the text.
 * @returns The prompt block.
 */
export function textBlock(text: string, images: ReadonlyArray<ImageAttachment> = []): PromptBlock {
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
    cacheBreakpoint: undefined,
    toolDescription: "stable tools",
    toolNames: new Set(["read"]),
    ...overrides,
  };
}

/**
 * Deliver one `PreToolUse` event to a hook the way the SDK does.
 *
 * @param hook - Hook under test.
 * @param toolUseId - SDK tool-use identifier.
 * @param toolInput - Raw model-supplied tool input.
 * @param toolName - SDK tool name, the Pi gateway by default.
 * @returns The hook's permission output.
 */
export function deliverToolUse(
  hook: HookCallback,
  toolUseId: string,
  toolInput: unknown,
  toolName = "mcp__pi__pi_call",
): ReturnType<HookCallback> {
  // SAFETY: Tests supply every field read by the PreToolUse hook. Remaining SDK fields are irrelevant to it and owned by the third-party runtime.
  const input = {
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_use_id: toolUseId,
    tool_input: toolInput,
  } as Parameters<HookCallback>[0];
  return hook(input, toolUseId, { signal: new AbortController().signal });
}

/**
 * Read the `PreToolUse` hook the runner installed on an SDK query.
 *
 * @param params - Parameters captured from the fake SDK query.
 * @returns The installed hook.
 */
export function installedHook(params: Parameters<RunSdkQuery>[0]): HookCallback {
  const hook = params.options?.hooks?.PreToolUse?.[0]?.hooks?.[0];
  if (!hook) throw new Error("test setup: PreToolUse hook missing from SDK query options");
  return hook;
}

/**
 * Build a terminal SDK result message.
 *
 * @param fields - Fields that differ from a clean `end_turn` result.
 * @returns The SDK result message.
 */
export function resultMessage(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "result", is_error: false, stop_reason: "end_turn", ...fields };
}

/**
 * Build an SDK partial-message stream event.
 *
 * @param event - Anthropic stream event payload.
 * @returns The SDK stream message.
 */
export function streamEvent(event: Record<string, unknown>): Record<string, unknown> {
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
export function sdkPromptFixture(prompt: unknown): AsyncIterable<SDKUserMessage> {
  if (typeof prompt !== "object" || prompt === null || !(Symbol.asyncIterator in prompt)) {
    throw new Error("test setup: expected an async SDK prompt");
  }
  // SAFETY: The runner always supplies buildPromptStream(), whose yielded value is SDKUserMessage. The runtime check rejects non-streaming prompt variants.
  return prompt as AsyncIterable<SDKUserMessage>;
}

/**
 * Expose SDK content blocks as records for metadata-only assertions.
 *
 * @param message - SDK user message built by the prompt adapter.
 * @returns Content blocks as unknown-valued records.
 */
export function sdkContentRecords(
  message: SDKUserMessage | undefined,
): Array<Record<string, unknown>> {
  if (!(message && Array.isArray(message.message.content))) return [];
  // SAFETY: SDK content is verified as an array. Record values remain unknown, and tests only inspect metadata after narrowing.
  return message.message.content as unknown as Array<Record<string, unknown>>;
}
