import { readFileSync } from "node:fs";
import { env } from "node:process";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";

const API = "feedback-scripted";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const Script = Schema.Array(
  Schema.Array(
    Schema.Struct({
      name: Schema.String,
      arguments: Schema.Record(Schema.String, Schema.Json),
    }),
  ),
);

function stepCalls(index: number): readonly ToolCall[] {
  const file = env.PI_FEEDBACK_SCRIPT;
  if (file === undefined || file === "") {
    throw new Error("PI_FEEDBACK_SCRIPT is required");
  }
  const steps = Schema.decodeUnknownSync(Schema.fromJsonString(Script))(readFileSync(file, "utf8"));
  return (steps[index] ?? []).map((call, position) => ({
    type: "toolCall",
    id: `call-${index}-${position}`,
    name: call.name,
    arguments: { ...call.arguments },
  }));
}

export default function scriptedModel(pi: ExtensionAPI): void {
  pi.registerProvider("feedback-e2e", {
    name: "Offline scripted model",
    baseUrl: "scripted://offline",
    apiKey: "scripted-offline",
    api: API,
    models: [
      {
        id: "scripted",
        name: "Scripted",
        reasoning: false,
        input: ["text"],
        cost: ZERO_COST,
        contextWindow: 200_000,
        maxTokens: 8192,
      },
    ],
    streamSimple: (model, context) => {
      const stream = createAssistantMessageEventStream();
      const index = context.messages.filter(({ role }) => role === "assistant").length;
      const toolCalls = stepCalls(index);
      const text = `Step ${index} done.`;
      const message: AssistantMessage = {
        role: "assistant",
        content: toolCalls.length > 0 ? [...toolCalls] : [{ type: "text", text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { ...ZERO_COST, total: 0 },
        },
        stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        for (const [contentIndex, toolCall] of toolCalls.entries()) {
          const partial = { ...message, content: toolCalls.slice(0, contentIndex + 1) };
          stream.push({ type: "toolcall_start", contentIndex, partial });
          stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
        }
        if (toolCalls.length === 0) {
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
        }
        stream.push({ type: "done", reason: toolCalls.length > 0 ? "toolUse" : "stop", message });
        stream.end(message);
      });
      return stream;
    },
  });
}
