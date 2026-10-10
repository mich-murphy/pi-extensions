import type {
  HookCallback,
  HookJSONOutput,
  PreToolUseHookInput,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { Context, Model, TranscriptContext } from "@earendil-works/pi-ai";
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
 * @param input - Deliberately partial framework context fixture.
 * @returns The fixture as a normalized provider context.
 */
export function contextFixture(input: unknown): TranscriptContext {
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
export function transcriptFixture(messages: readonly unknown[]): TranscriptContext {
  return { messages } as unknown as TranscriptContext;
}

/** Fields a test varies on an otherwise complete Claude SDK model. */
type ModelFixtureFields = {
  /** Pi-facing model ID. */
  readonly id: string;
  /** Whether the model accepts effort-based reasoning. */
  readonly reasoning?: boolean;
};

/**
 * Build a complete Claude SDK model with subscription pricing.
 *
 * @param fields - The model ID and, when it matters, its reasoning support.
 * @returns The Claude SDK model.
 */
export function modelFixture({ id, reasoning = false }: ModelFixtureFields): Model<"claude-sdk"> {
  return {
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
  return new Promise<T>(() => {
    // Never settles.
  });
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
    cacheBreakpoint: undefined,
    toolDescription: "stable tools",
    toolNames: new Set(["read"]),
    ...overrides,
  };
}

/** One tool use the model requested, as the SDK reports it to a `PreToolUse` hook. */
export type ToolUse = {
  /** SDK tool-use identifier. */
  readonly id: string;
  /** Raw model-supplied tool input. */
  readonly input: unknown;
  /** SDK tool name, the Pi gateway by default. */
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
  { id, input, toolName = "mcp__pi__pi_call" }: ToolUse,
): Promise<HookJSONOutput> {
  const hookInput = {
    session_id: "test-session",
    transcript_path: "/dev/null",
    cwd: "/",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_use_id: id,
    tool_input: input,
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
