import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  ToolCall,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import adapter from "../../index.js";
import spike from "./extension.js";

function log(type: string, data: unknown): void {
  const file = process.env.PI_SPIKE_LOG;
  if (file !== undefined) {
    appendFileSync(file, `${JSON.stringify({ type, data })}\n`);
  }
}

type Call = { name: string; arguments: ToolCall["arguments"] };
function controlObject(value: unknown) {
  if (typeof value !== "object" || value === null || !("op" in value)) {
    return undefined;
  }
  return value;
}
function controlMode(value: object): string | undefined {
  if ("mode" in value && typeof value.mode === "string") {
    return value.mode;
  }
  return undefined;
}
function signalOf(options: SimpleStreamOptions | undefined): AbortSignal | undefined {
  return options?.signal;
}
function onAbort(signal: AbortSignal | undefined, action: () => void): void {
  if (signal?.aborted === true) {
    action();
  } else {
    signal?.addEventListener("abort", action, { once: true });
  }
}
function authoredCall(
  content: Extract<TranscriptContext["messages"][number], { role: "user" }>["content"],
): Call {
  const raw =
    typeof content === "string"
      ? content
      : content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Isolated authored test prompt contains this bounded tool-call fixture.
  return JSON.parse(raw.slice(raw.indexOf("ADAPTER_CALL:") + "ADAPTER_CALL:".length)) as Call;
}
function nextCall(last: TranscriptContext["messages"][number] | undefined): Call | undefined {
  if (last?.role !== "user") {
    return undefined;
  }
  const text = JSON.stringify(last);
  if (text.includes("ADAPTER_CALL:")) {
    return authoredCall(last.content);
  }
  if (text.includes("New collaboration messages are available")) {
    return { name: "session_take", arguments: { limit: 8 } };
  }
  return undefined;
}
function response(model: Model<Api>, call: Call | undefined): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    content:
      call === undefined
        ? [{ type: "text", text: "Offline scheduling only." }]
        : [{ type: "toolCall", id: `${Date.now()}`, ...call }],
    stopReason: call === undefined ? "stop" : "toolUse",
    usage: {
      input: 10,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 11,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function finish(
  stream: AssistantMessageEventStream,
  message: AssistantMessage,
  aborted: boolean,
): void {
  if (aborted) {
    message.stopReason = "aborted";
    message.errorMessage = "offline abort";
    stream.push({ type: "error", reason: "aborted", error: message });
  } else {
    stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
  }
  stream.end(message);
}
function responseAborted(options: SimpleStreamOptions | undefined): boolean {
  return signalOf(options)?.aborted === true;
}
async function recordPayload(
  options: SimpleStreamOptions | undefined,
  transcript: TranscriptContext,
  model: Model<Api>,
): Promise<unknown> {
  return options?.onPayload?.({ messages: transcript.messages }, model);
}

// eslint-disable-next-line import/no-default-export -- Pi's test-only extension entry point.
export default function productionJourney(pi: ExtensionAPI): void {
  spike(pi);
  adapter(pi);
  let mode = "success";
  let release: (() => void) | undefined;
  const changeMode = (command: object) => {
    mode = controlMode(command) ?? mode;
  };
  const releaseResponse = () => {
    release?.();
  };
  const unsubscribe = pi.events.on("spike:control", (value) => {
    const command = controlObject(value);
    if (command === undefined) {
      return;
    }
    if (command.op === "mode") {
      changeMode(command);
    }
    if (command.op === "release") {
      releaseResponse();
    }
  });
  pi.on("session_shutdown", () => {
    unsubscribe();
    release?.();
  });
  pi.on("message_end", (event) => {
    log("production_message", event.message);
  });
  const holdResponse = async (options: SimpleStreamOptions | undefined) => {
    await new Promise<void>((resolve) => {
      release = resolve;
      onAbort(signalOf(options), () => {
        log("production_abort", {});
        void delay(150).then(resolve);
      });
    });
    release = undefined;
  };
  pi.registerProvider("spike", {
    baseUrl: "offline://production-adapter",
    apiKey: "offline-not-a-credential",
    api: "production-adapter-recorder",
    models: [
      {
        id: "recorder",
        name: "Offline production adapter recorder",
        reasoning: false,
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple: (model, transcript, options) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const payload = await recordPayload(options, transcript, model);
        log("production_request", { mode, messages: transcript.messages, payload });
        if (mode === "hold") {
          await holdResponse(options);
        }
        const call = nextCall(transcript.messages.at(-1));
        finish(stream, response(model, call), responseAborted(options));
      })();
      return stream;
    },
  });
}
