import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Option, Schema } from "effect";

const TOKEN = /peer-msg-\d+/gu;
let calls = 0;

function reply(model: Model<Api>, take: boolean): AssistantMessage {
  calls += 1;
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    content: take
      ? [{ type: "toolCall", id: `take-${calls}`, name: "peers_take", arguments: { limit: 8 } }]
      : [{ type: "text", text: "taken" }],
    stopReason: take ? "toolUse" : "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

const decodeTaken = Schema.decodeUnknownOption(
  Schema.Struct({
    value: Schema.Struct({
      messages: Schema.Array(Schema.Struct({ message: Schema.Struct({ content: Schema.String }) })),
    }),
  }),
);

function registerProbe(pi: ExtensionAPI): void {
  const seen = new Set<string>();
  let duplicate: string | undefined;
  let final = false;
  const text = (): string =>
    `peers-probe taken=${seen.size} dup=${duplicate ?? "none"} final=${final ? "yes" : "no"}`;
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("peers-probe", text());
  });
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "peers_take") {
      return;
    }
    const taken = decodeTaken(event.details);
    if (Option.isNone(taken)) {
      return;
    }
    for (const {
      message: { content },
    } of taken.value.value.messages) {
      for (const token of content.match(TOKEN) ?? []) {
        duplicate ??= seen.has(token) ? token : undefined;
        seen.add(token);
      }
      final ||= content.includes(" final ");
    }
    ctx.ui.setStatus("peers-probe", text());
  });
}

export default function bombadilPeersHarness(pi: ExtensionAPI): void {
  registerProbe(pi);
  pi.registerProvider("scripted", {
    baseUrl: "offline://scripted",
    apiKey: "offline-not-a-credential",
    api: "offline-scripted",
    models: [
      {
        id: "peers",
        name: "Scripted peers_take caller",
        reasoning: false,
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple: (model, transcript) => {
      const stream = createAssistantMessageEventStream();
      const message = reply(model, transcript.messages.at(-1)?.role !== "toolResult");
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [], stopReason: "stop" } });
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end(message);
      });
      return stream;
    },
  });
}
