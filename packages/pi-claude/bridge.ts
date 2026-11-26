import { randomUUID } from "node:crypto";
import { calculateCost, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { absurd } from "effect/Function";
import { buildAgentRequest, endsWithPrintedToolCall } from "./agent-request";
import type { AgentRequest } from "./agent-request";
import { SdkProviderDefect } from "./sdk/errors";
import type { SdkRunError, SdkTurnFailure } from "./sdk/errors";
import { formatSdkRunError, writeSdkFailureDiagnostic } from "./sdk/failure-diagnostics";
import { VALIDATION_ERROR_TOOL } from "./validation-recovery";

export type TokenUsage = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cacheWrite1h?: number;
  readonly cacheWrite5m?: number;
};

export type ReadonlyJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ReadonlyJsonValue[]
  | ReadonlyJsonObject;

export type ReadonlyJsonObject = { readonly [key: string]: ReadonlyJsonValue };

export type DeferredCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: ReadonlyJsonObject;
};

export type BridgeEvent =
  | { readonly type: "text_delta" | "thinking_delta"; readonly text: string }
  | { readonly type: "usage"; readonly usage: TokenUsage }
  | { readonly type: "done"; readonly reason: "stop" | "length" }
  | { readonly type: "tool_calls"; readonly calls: readonly DeferredCall[] }
  | { readonly type: "failed"; readonly error: SdkRunError };

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

class AssistantMessageWriter {
  readonly stream = createAssistantMessageEventStream();
  private readonly output: AssistantMessage;
  private open: TextContent | ThinkingContent | undefined;
  private ended = false;

  constructor(
    private readonly model: Model<Api>,
    private readonly signal: AbortSignal | undefined,
  ) {
    this.output = initialAssistantMessage(model);
    this.stream.push({ type: "start", partial: this.output });
  }

  write(event: BridgeEvent): boolean {
    switch (event.type) {
      case "text_delta": {
        this.append("text", event.text);

        return false;
      }

      case "thinking_delta": {
        this.append("thinking", event.text);

        return false;
      }

      case "usage": {
        const { input, output, cacheRead, cacheWrite, cacheWrite1h } = event.usage;
        const totalTokens = input + output + cacheRead + cacheWrite;
        Object.assign(
          this.output.usage,
          { input, output, cacheRead, cacheWrite, totalTokens },
          cacheWrite1h === undefined ? {} : { cacheWrite1h },
        );

        if (cacheWrite1h === undefined) {
          delete this.output.usage.cacheWrite1h;
        }

        calculateCost(this.model, this.output.usage);

        return false;
      }

      case "done": {
        if (event.reason === "stop" && this.endsWithPrintedCall()) {
          this.appendToolCall({
            id: `printed-call-${randomUUID()}`,
            name: VALIDATION_ERROR_TOOL,
            arguments: { error: "printed_tool_call" },
          });
          this.finish("toolUse");

          return true;
        }

        this.finish(event.reason);

        return true;
      }

      case "tool_calls": {
        for (const call of event.calls) {
          this.appendToolCall(call);
        }

        this.finish("toolUse");

        return true;
      }

      case "failed": {
        this.fail(event.error);

        return true;
      }

      default: {
        return absurd(event);
      }
    }
  }

  async pump(events: () => AsyncIterable<BridgeEvent>): Promise<void> {
    try {
      for await (const event of events()) {
        if (this.write(event)) {
          return;
        }
      }

      this.fail(new SdkProviderDefect({ reason: "no-terminal-event" }));
    } catch (error) {
      this.abandon(error);
    }
  }

  abandon(cause: unknown): void {
    this.fail(new SdkProviderDefect({ reason: "run-rejected", cause }));
  }

  private fail(error: SdkTurnFailure): void {
    if (this.ended) {
      return;
    }

    this.ended = true;
    this.output.stopReason = this.signal?.aborted === true ? "aborted" : "error";

    try {
      this.closeOpenBlock();
      this.output.errorMessage = formatSdkRunError(error);
      this.stream.push({ type: "error", reason: this.output.stopReason, error: this.output });
    } finally {
      this.stream.end(this.output);
    }

    try {
      writeSdkFailureDiagnostic(error);
    } catch {
      return undefined;
    }
  }

  private endsWithPrintedCall(): boolean {
    const last = this.output.content.at(-1);

    return last?.type === "text" && endsWithPrintedToolCall(last.text);
  }

  private get lastIndex(): number {
    return this.output.content.length - 1;
  }

  private append(kind: "text" | "thinking", delta: string): void {
    if (this.open?.type !== kind) {
      this.closeOpenBlock();
      this.open = kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
      this.output.content.push(this.open);
      this.stream.push({
        type: `${kind}_start`,
        contentIndex: this.lastIndex,
        partial: this.output,
      });
    }

    if (this.open.type === "text") {
      this.open.text += delta;
    } else {
      this.open.thinking += delta;
    }

    this.stream.push({
      type: `${kind}_delta`,
      contentIndex: this.lastIndex,
      delta,
      partial: this.output,
    });
  }

  private closeOpenBlock(): void {
    const block = this.open;

    if (!block) {
      return;
    }

    this.open = undefined;
    this.stream.push({
      type: `${block.type}_end`,
      contentIndex: this.lastIndex,
      content: block.type === "text" ? block.text : block.thinking,
      partial: this.output,
    });
  }

  private appendToolCall(call: DeferredCall): void {
    this.closeOpenBlock();
    const toolCall = { ...call, type: "toolCall" as const, arguments: { ...call.arguments } };
    this.output.content.push(toolCall);
    const position = { contentIndex: this.lastIndex, partial: this.output };
    this.stream.push({ type: "toolcall_start", ...position });
    this.stream.push({ type: "toolcall_end", toolCall, ...position });
  }

  private finish(reason: "stop" | "length" | "toolUse"): void {
    this.ended = true;
    this.output.stopReason = reason;

    try {
      this.closeOpenBlock();
      this.stream.push({ type: "done", reason, message: this.output });
    } finally {
      this.stream.end(this.output);
    }
  }
}

export type AgentSdkStreamInput = {
  readonly model: Model<Api>;
  readonly context: TranscriptContext;
  readonly options: SimpleStreamOptions | undefined;
  readonly run: AgentSdkRun;
};

export function createAgentSdkStream({
  model,
  context,
  options,
  run,
}: AgentSdkStreamInput): AssistantMessageEventStream {
  const writer = new AssistantMessageWriter(model, options?.signal);
  writer
    .pump(() => run(buildAgentRequest(context), model, options))
    .catch(writer.abandon.bind(writer));

  return writer.stream;
}
