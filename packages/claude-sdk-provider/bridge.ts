import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  calculateCost,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
} from "@earendil-works/pi-ai";
import { type AgentRequest, buildAgentRequest } from "./agent-request";
import { SdkQueryError, type SdkRunError } from "./sdk/errors";
import { formatSdkRunError, writeSdkFailureDiagnostic } from "./sdk/failure-diagnostics";

/** Complete token counts for the latest model call of a turn. */
export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** A Pi tool request captured by the SDK hook and deferred to Pi for execution. */
export interface DeferredCall {
  /** SDK tool-use identifier. */
  readonly id: string;
  /** Exact Pi tool name. */
  readonly name: string;
  /** Parsed object arguments supplied for the Pi tool. */
  readonly arguments: Readonly<Record<string, unknown>>;
}

/**
 * Events exchanged between the SDK adapter and Pi stream adapter. A turn is any
 * number of deltas and usage updates followed by exactly one terminal event:
 * `done`, `tool_calls`, or `failed`.
 */
export type BridgeEvent =
  | { readonly type: "text_delta" | "thinking_delta"; readonly text: string }
  | { readonly type: "usage"; readonly usage: TokenUsage }
  | { readonly type: "done"; readonly reason: "stop" | "length" }
  | { readonly type: "tool_calls"; readonly calls: ReadonlyArray<DeferredCall> }
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

/** Builds one Pi assistant message while mirroring each change onto Pi's event stream. */
class AssistantMessageWriter {
  readonly stream = createAssistantMessageEventStream();
  private readonly output: AssistantMessage;
  // Deltas only ever extend the newest content block, so one reference is the whole cursor.
  private open: TextContent | ThinkingContent | undefined;

  constructor(
    private readonly model: Model<Api>,
    private readonly signal: AbortSignal | undefined,
  ) {
    this.output = initialAssistantMessage(model);
    this.stream.push({ type: "start", partial: this.output });
  }

  /** Apply one bridge event and report whether it ended the turn. */
  write(event: BridgeEvent): boolean {
    switch (event.type) {
      case "text_delta":
        this.append("text", event.text);
        return false;
      case "thinking_delta":
        this.append("thinking", event.text);
        return false;
      case "usage": {
        const { input, output, cacheRead, cacheWrite } = event.usage;
        const totalTokens = input + output + cacheRead + cacheWrite;
        Object.assign(this.output.usage, event.usage, { totalTokens });
        calculateCost(this.model, this.output.usage);
        return false;
      }
      case "done":
        this.finish(event.reason);
        return true;
      case "tool_calls":
        for (const call of event.calls) this.appendToolCall(call);
        this.finish("toolUse");
        return true;
      case "failed":
        this.fail(event.error);
        return true;
    }
  }

  fail(error: SdkRunError): void {
    this.closeOpenBlock();
    this.output.stopReason = this.signal?.aborted ? "aborted" : "error";
    this.output.errorMessage = formatSdkRunError(error);
    writeSdkFailureDiagnostic(error);
    this.stream.push({ type: "error", reason: this.output.stopReason, error: this.output });
    this.stream.end();
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
    if (this.open.type === "text") this.open.text += delta;
    else this.open.thinking += delta;
    this.stream.push({
      type: `${kind}_delta`,
      contentIndex: this.lastIndex,
      delta,
      partial: this.output,
    });
  }

  private closeOpenBlock(): void {
    const block = this.open;
    if (!block) return;
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
    this.closeOpenBlock();
    this.output.stopReason = reason;
    this.stream.push({ type: "done", reason, message: this.output });
    this.stream.end();
  }
}

async function pump(writer: AssistantMessageWriter, events: () => AsyncIterable<BridgeEvent>) {
  try {
    for await (const event of events()) if (writer.write(event)) return;
    writer.fail(
      new SdkQueryError("terminal-result", "bridge stream ended without a terminal event"),
    );
  } catch (cause) {
    writer.fail(new SdkQueryError("iterate", cause));
  }
}

/** Adapt SDK bridge events to Pi's assistant-message event stream. */
export function createAgentSdkStream(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  run: AgentSdkRun,
): AssistantMessageEventStream {
  const writer = new AssistantMessageWriter(model, options?.signal);
  void pump(writer, () => run(buildAgentRequest(context), model, options));
  return writer.stream;
}
