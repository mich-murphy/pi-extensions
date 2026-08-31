import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  calculateCost,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { type AgentRequest, buildAgentRequest } from "./agent-request";
import { SdkQueryError, type SdkRunError } from "./sdk/errors";

/** Events exchanged between the SDK adapter and Pi stream adapter. */
export type BridgeEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "thinking_delta"; readonly text: string }
  | {
      readonly type: "tool_call";
      readonly id: string;
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "usage";
      readonly input?: number;
      readonly output?: number;
      readonly cacheRead?: number;
      readonly cacheWrite?: number;
    }
  | { readonly type: "done"; readonly reason: "stop" | "length" }
  | { readonly type: "failed"; readonly error: SdkRunError };

/** Stateless SDK operation used by the Pi stream adapter. */
export type AgentSdkRun = (
  request: AgentRequest,
  model: Model<Api>,
  options?: SimpleStreamOptions,
) => AsyncIterable<BridgeEvent>;

function initialAssistantMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function textualDeltaEvent(
  kind: "text" | "thinking",
  contentIndex: number,
  delta: string,
  partial: AssistantMessage,
): AssistantMessageEvent {
  if (kind === "text") return { type: "text_delta", contentIndex, delta, partial };
  return { type: "thinking_delta", contentIndex, delta, partial };
}

function textualEndEvent(
  kind: "text" | "thinking",
  contentIndex: number,
  content: string,
  partial: AssistantMessage,
): AssistantMessageEvent {
  if (kind === "text") return { type: "text_end", contentIndex, content, partial };
  return { type: "thinking_end", contentIndex, content, partial };
}

class AgentStreamAdapter {
  private readonly stream = createAssistantMessageEventStream();
  private readonly output: AssistantMessage;
  private textIndex: number | undefined;
  private thinkingIndex: number | undefined;

  constructor(
    private readonly model: Model<Api>,
    private readonly context: Context,
    private readonly options: SimpleStreamOptions | undefined,
    private readonly runSdk: AgentSdkRun,
  ) {
    this.output = initialAssistantMessage(model);
  }

  start(): AssistantMessageEventStream {
    this.consume().catch((cause: unknown) => this.fail(new SdkQueryError("iterate", cause)));
    return this.stream;
  }

  private async consume(): Promise<void> {
    try {
      this.stream.push({ type: "start", partial: this.output });
      for await (const event of this.runSdk(
        buildAgentRequest(this.context),
        this.model,
        this.options,
      )) {
        if (this.handle(event)) return;
      }
      this.finishIncompleteStream();
    } catch (cause) {
      this.fail(new SdkQueryError("iterate", cause));
    }
  }

  private handle(event: BridgeEvent): boolean {
    switch (event.type) {
      case "text_delta":
        this.appendText(event.text);
        return false;
      case "thinking_delta":
        this.appendThinking(event.text);
        return false;
      case "usage":
        this.updateUsage(event);
        return false;
      case "tool_call":
        this.appendToolCall(event);
        return false;
      case "done":
        this.finish(event.reason);
        return true;
      case "failed":
        this.fail(event.error);
        return true;
    }
  }

  private appendText(delta: string): void {
    this.closeThinking();
    this.textIndex ??= this.startContent("text");
    this.appendContent("text", this.textIndex, delta);
  }

  private appendThinking(delta: string): void {
    this.closeText();
    this.thinkingIndex ??= this.startContent("thinking");
    this.appendContent("thinking", this.thinkingIndex, delta);
  }

  private appendContent(kind: "text" | "thinking", contentIndex: number, delta: string): void {
    const block = this.output.content[contentIndex];
    if (kind === "text" && block?.type === "text") block.text += delta;
    if (kind === "thinking" && block?.type === "thinking") block.thinking += delta;
    this.stream.push(textualDeltaEvent(kind, contentIndex, delta, this.output));
  }

  private startContent(kind: "text" | "thinking"): number {
    const contentIndex = this.output.content.length;
    if (kind === "text") {
      this.output.content.push({ type: "text", text: "" });
      this.stream.push({ type: "text_start", contentIndex, partial: this.output });
    } else {
      this.output.content.push({ type: "thinking", thinking: "" });
      this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
    }
    return contentIndex;
  }

  private closeText(): void {
    const index = this.textIndex;
    this.textIndex = undefined;
    this.closeContent("text", index);
  }

  private closeThinking(): void {
    const index = this.thinkingIndex;
    this.thinkingIndex = undefined;
    this.closeContent("thinking", index);
  }

  private closeContent(kind: "text" | "thinking", contentIndex: number | undefined): void {
    if (contentIndex === undefined) return;
    const block = this.output.content[contentIndex];
    let content: string | undefined;
    if (kind === "text" && block?.type === "text") content = block.text;
    if (kind === "thinking" && block?.type === "thinking") content = block.thinking;
    if (content === undefined) return;
    this.stream.push(textualEndEvent(kind, contentIndex, content, this.output));
  }

  private updateUsage(event: Extract<BridgeEvent, { type: "usage" }>): void {
    if (event.input !== undefined) this.output.usage.input = event.input;
    if (event.output !== undefined) this.output.usage.output = event.output;
    if (event.cacheRead !== undefined) this.output.usage.cacheRead = event.cacheRead;
    if (event.cacheWrite !== undefined) this.output.usage.cacheWrite = event.cacheWrite;
    this.output.usage.totalTokens =
      this.output.usage.input +
      this.output.usage.output +
      this.output.usage.cacheRead +
      this.output.usage.cacheWrite;
    calculateCost(this.model, this.output.usage);
  }

  private appendToolCall(event: Extract<BridgeEvent, { type: "tool_call" }>): void {
    this.closeOpenBlocks();
    const contentIndex = this.output.content.length;
    const toolCall = {
      type: "toolCall" as const,
      id: event.id,
      name: event.name,
      arguments: event.arguments,
    };
    this.output.content.push(toolCall);
    this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
    this.stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: this.output });
    this.output.stopReason = "toolUse";
  }

  private finish(reason: "stop" | "length"): void {
    this.closeOpenBlocks();
    this.output.stopReason = reason;
    this.stream.push({ type: "done", reason, message: this.output });
    this.stream.end();
  }

  private fail(error: SdkRunError): void {
    this.closeOpenBlocks();
    this.output.stopReason = this.options?.signal?.aborted ? "aborted" : "error";
    this.output.errorMessage = error.message;
    this.stream.push({ type: "error", reason: this.output.stopReason, error: this.output });
    this.stream.end();
  }

  private finishIncompleteStream(): void {
    if (this.output.content.some((block) => block.type === "toolCall")) {
      this.closeOpenBlocks();
      this.output.stopReason = "toolUse";
      this.stream.push({ type: "done", reason: "toolUse", message: this.output });
      this.stream.end();
      return;
    }
    this.fail(new SdkQueryError("terminal-result", "bridge stream ended without a terminal event"));
  }

  private closeOpenBlocks(): void {
    this.closeText();
    this.closeThinking();
  }
}

/** Adapt SDK bridge events to Pi's assistant-message event stream. */
export function createAgentSdkStream(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  run: AgentSdkRun,
): AssistantMessageEventStream {
  return new AgentStreamAdapter(model, context, options, run).start();
}
