import { appendFileSync } from "node:fs";
import { env } from "node:process";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  ToolCall,
  TranscriptContext,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const API = "skills-recorder";
const READ_FILES = "READ-FILES: ";
const RUN_BASH = "RUN-BASH: ";
const SPAWN_CHILD = "SPAWN-CHILD";

type ScriptedCall = Pick<ToolCall, "name" | "arguments">;

function textOf(content: UserMessage["content"]): string {
  return Array.isArray(content)
    ? content.map((block) => (block.type === "text" ? block.text : "")).join("\n")
    : content;
}

function markedLines(text: string, marker: string): string[] {
  return text.split("\n").flatMap((line) => {
    const at = line.indexOf(marker);
    return at === -1 ? [] : [line.slice(at + marker.length).trim()];
  });
}

function fileAndShellCalls(text: string): ScriptedCall[] {
  return [
    ...markedLines(text, READ_FILES).flatMap((line) =>
      line
        .split("|")
        .filter(Boolean)
        .map((path) => ({ name: "read", arguments: { path } })),
    ),
    ...markedLines(text, RUN_BASH).map((command) => ({ name: "bash", arguments: { command } })),
  ];
}

function scriptedCalls(
  messages: readonly TranscriptContext["messages"][number][],
): readonly ScriptedCall[] {
  let lastAssistant = -1;
  for (const [position, { role }] of messages.entries()) {
    if (role === "assistant") {
      lastAssistant = position;
    }
  }
  const pending = messages.slice(lastAssistant + 1);
  if (pending.some(({ role }) => role === "toolResult")) {
    return [];
  }
  const text = pending
    .filter((message) => message.role === "user")
    .map(({ content }) => textOf(content))
    .join("\n");
  const spawn = text.indexOf(SPAWN_CHILD);
  if (spawn === -1) {
    return fileAndShellCalls(text);
  }
  const task = text.slice(spawn + SPAWN_CHILD.length).trim();
  return [
    {
      name: "subagent",
      arguments: {
        prompt: task,
        description: "verify child reads",
        subagent_type: "general-purpose",
      },
    },
  ];
}
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function recorderModel(id: string, name: string, midConvo: boolean) {
  return {
    id,
    name,
    api: API,
    reasoning: false,
    input: ["text" as const],
    cost: ZERO_COST,
    contextWindow: 200_000,
    maxTokens: 8192,
    ...(midConvo ? { compat: { supportsMidConvoSystemMessages: true } } : {}),
  };
}

export default function registerRecorder(pi: ExtensionAPI): void {
  let requests = 0;
  pi.registerProvider("recorder", {
    name: "Offline prompt recorder",
    baseUrl: "recorder://offline",
    apiKey: "recorder-offline",
    api: API,
    models: [
      recorderModel("codex-like", "Recorder (mid-convo system messages)", true),
      recorderModel("collapse-like", "Recorder (collapsed system prompt)", false),
    ],
    streamSimple: (model, context, options) => {
      const stream = createAssistantMessageEventStream();
      requests += 1;
      const index = requests;
      void (async () => {
        const payload = {
          index,
          at: Date.now(),
          model: model.id,
          sessionId: options?.sessionId ?? null,
          compat: model.compat ?? null,
          messages: context.messages,
        };
        const replaced = await options?.onPayload?.(payload, model);
        const file = env.PI_SKILL_TOGGLE_RECORDER_FILE;
        if (file !== undefined && file !== "") {
          appendFileSync(file, `${JSON.stringify(replaced === undefined ? payload : replaced)}\n`);
        }
        const calls = scriptedCalls(context.messages);
        const text = `Recorded request ${index}.`;
        const input = Math.ceil(JSON.stringify(context.messages).length / 4);
        const toolCalls = calls.map((call, position): ToolCall => ({
          type: "toolCall",
          id: `call-${index}-${position}`,
          name: call.name,
          arguments: call.arguments,
        }));
        const message: AssistantMessage = {
          role: "assistant",
          content: toolCalls.length > 0 ? toolCalls : [{ type: "text", text }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input,
            output: 6,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: input + 6,
            cost: { ...ZERO_COST, total: 0 },
          },
          stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
          timestamp: Date.now(),
        };
        const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
        stream.push({ type: "start", partial });
        if (toolCalls.length > 0) {
          for (const [contentIndex, toolCall] of toolCalls.entries()) {
            const sofar = { ...partial, content: toolCalls.slice(0, contentIndex + 1) };
            stream.push({ type: "toolcall_start", contentIndex, partial: sofar });
            stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: sofar });
          }
          stream.push({ type: "done", reason: "toolUse", message });
          stream.end(message);
          return;
        }
        const done: AssistantMessage = { ...partial, content: [{ type: "text", text }] };
        stream.push({ type: "text_start", contentIndex: 0, partial: done });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: done });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: done });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      })();
      return stream;
    },
  });
}
