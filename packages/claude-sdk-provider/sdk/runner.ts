import process from "node:process";
import { createSdkMcpServer, query } from "@anthropic-ai/claude-agent-sdk";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AgentRequest } from "../agent-request";
import type { AgentSdkRun, BridgeEvent } from "../bridge";
import type { CacheDiagnosticTracker } from "../cache-tracker";
import {
  createDeferredPiCallTool,
  createPreToolUseHook,
  type DeferredCall,
} from "./deferred-tools";
import {
  type InvalidDeferredCallError,
  InvalidDeferredCallLimitError,
  SdkProtocolError,
  SdkQueryError,
  SdkResultError,
  type SdkRunError,
} from "./errors";
import {
  type ResultOutcome,
  record,
  resultOutcome,
  translateSdkStreamEvent,
} from "./event-translation";
import { buildPromptStream } from "./prompt-stream";
import { subscriptionEnvironment } from "./subscription-environment";

/** Injectable Claude Agent SDK query function used by the runner and its tests. */
export type RunSdkQuery = (params: Parameters<typeof query>[0]) => AsyncIterable<unknown>;

type UsageEvent = Required<Extract<BridgeEvent, { type: "usage" }>>;
type QueryStart =
  | { readonly _tag: "ok"; readonly query: AsyncIterable<unknown> }
  | { readonly _tag: "err"; readonly error: SdkQueryError };
type MessageAction =
  | { readonly _tag: "emit"; readonly event: BridgeEvent | undefined }
  | { readonly _tag: "fail"; readonly error: SdkRunError };
type TurnDependencies = {
  readonly runSdkQuery: RunSdkQuery;
  readonly cacheDiagnostics: CacheDiagnosticTracker | undefined;
  readonly sdkEnvironment: Readonly<Record<string, string | undefined>>;
};

const MAX_INVALID_PI_CALLS = 3;

function effortFor(
  reasoning: SimpleStreamOptions["reasoning"],
): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  if (!reasoning) return undefined;
  return reasoning === "minimal" ? "low" : reasoning;
}

function reasoningOptions(
  model: Model<Api>,
  reasoning: SimpleStreamOptions["reasoning"],
): { effort?: "low" | "medium" | "high" | "xhigh" | "max" } {
  if (!model.reasoning) return {};
  const effort = effortFor(reasoning);
  return effort === undefined ? {} : { effort };
}

function isSdkRunError(error: unknown): error is SdkRunError {
  return (
    error instanceof InvalidDeferredCallLimitError ||
    error instanceof SdkProtocolError ||
    error instanceof SdkQueryError ||
    error instanceof SdkResultError
  );
}

class ClaudeSdkTurn {
  private readonly abortController = new AbortController();
  private readonly deferredCalls = new Map<string, DeferredCall>();
  private invalidCallCount = 0;
  private invalidCallLimitError: InvalidDeferredCallLimitError | undefined;
  private latestUsage: UsageEvent | undefined;
  private outcome: Extract<ResultOutcome, { _tag: "success" }> | undefined;
  private diagnosticTurn: number | undefined;

  constructor(
    private readonly request: AgentRequest,
    private readonly model: Model<Api>,
    private readonly options: SimpleStreamOptions | undefined,
    private readonly dependencies: TurnDependencies,
  ) {}

  async *run(): AsyncGenerator<BridgeEvent> {
    const removeAbortListener = this.forwardCancellation();
    try {
      if (this.abortController.signal.aborted) {
        yield { type: "failed", error: this.abortFailure() };
        return;
      }
      this.diagnosticTurn = this.dependencies.cacheDiagnostics?.request(
        `${this.model.provider}/${this.model.id}`,
        this.request.promptBlocks,
      );
      const started = this.startQuery();
      if (started._tag === "err") {
        yield { type: "failed", error: started.error };
        return;
      }
      const failed = yield* this.consume(started.query);
      if (failed) return;
      yield* this.finish();
    } finally {
      this.abortController.abort();
      removeAbortListener();
    }
  }

  private forwardCancellation(): () => void {
    const signal = this.options?.signal;
    const onAbort = (): void => this.abortController.abort(signal?.reason);
    if (signal?.aborted) this.abortController.abort(signal.reason);
    else signal?.addEventListener("abort", onAbort, { once: true });
    return () => signal?.removeEventListener("abort", onAbort);
  }

  private abortFailure(): SdkQueryError {
    return new SdkQueryError("start", this.abortController.signal.reason);
  }

  private startQuery(): QueryStart {
    try {
      return { _tag: "ok", query: this.dependencies.runSdkQuery(this.queryParameters()) };
    } catch (cause) {
      return { _tag: "err", error: new SdkQueryError("start", cause) };
    }
  }

  private queryParameters(): Parameters<RunSdkQuery>[0] {
    const piCall = createDeferredPiCallTool(this.request.toolDescription);
    const server = createSdkMcpServer({
      name: "pi",
      version: "0.1.0",
      tools: [piCall],
      alwaysLoad: true,
    });
    return {
      prompt: buildPromptStream(this.request.promptBlocks),
      options: {
        abortController: this.abortController,
        cwd: process.cwd(),
        model: this.model.id,
        ...reasoningOptions(this.model, this.options?.reasoning),
        includePartialMessages: true,
        persistSession: false,
        systemPrompt: this.request.systemPrompt,
        settingSources: [],
        tools: [],
        mcpServers: { pi: server },
        env: { ...this.dependencies.sdkEnvironment },
        hooks: {
          PreToolUse: [
            {
              hooks: [
                createPreToolUseHook(
                  new Set(this.request.toolNames),
                  (call) => this.captureToolCall(call),
                  (error) => this.captureInvalidCall(error),
                ),
              ],
            },
          ],
        },
      },
    };
  }

  private captureToolCall(call: DeferredCall): void {
    if (!this.deferredCalls.has(call.id)) this.deferredCalls.set(call.id, call);
  }

  private captureInvalidCall(error: InvalidDeferredCallError): void {
    this.invalidCallCount += 1;
    if (this.invalidCallCount <= MAX_INVALID_PI_CALLS) return;
    this.invalidCallLimitError ??= new InvalidDeferredCallLimitError(this.invalidCallCount, error);
    this.abortController.abort(this.invalidCallLimitError);
  }

  private async *consume(
    queryResult: AsyncIterable<unknown>,
  ): AsyncGenerator<BridgeEvent, boolean> {
    try {
      for await (const message of queryResult) {
        if (this.invalidCallLimitError) {
          yield { type: "failed", error: this.invalidCallLimitError };
          return true;
        }
        const action = this.processMessage(message);
        if (action._tag === "fail") {
          yield { type: "failed", error: action.error };
          return true;
        }
        if (action.event) yield action.event;
      }
      return false;
    } catch (cause) {
      yield { type: "failed", error: this.iterationError(cause) };
      return true;
    }
  }

  private processMessage(message: unknown): MessageAction {
    const asRecord = record(message);
    if (asRecord?.type === "result") return this.processResult(asRecord);
    const translated = translateSdkStreamEvent(message);
    if (translated._tag === "err") return { _tag: "fail", error: translated.error };
    if (translated.value?.type !== "usage") {
      return { _tag: "emit", event: translated.value };
    }
    this.latestUsage = this.mergeUsage(translated.value);
    return { _tag: "emit", event: this.latestUsage };
  }

  private processResult(message: Record<string, unknown>): MessageAction {
    const parsed = resultOutcome(message);
    if (parsed._tag !== "success") return { _tag: "fail", error: parsed.error };
    this.outcome = parsed;
    return { _tag: "emit", event: undefined };
  }

  private mergeUsage(event: Extract<BridgeEvent, { type: "usage" }>): UsageEvent {
    const previous = this.latestUsage ?? {
      type: "usage",
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    return {
      type: "usage",
      input: usageValue(event.input, previous.input),
      output: usageValue(event.output, previous.output),
      cacheRead: usageValue(event.cacheRead, previous.cacheRead),
      cacheWrite: usageValue(event.cacheWrite, previous.cacheWrite),
    };
  }

  private iterationError(cause: unknown): SdkRunError {
    return (
      this.invalidCallLimitError ??
      (isSdkRunError(cause) ? cause : new SdkQueryError("iterate", cause))
    );
  }

  private async *finish(): AsyncGenerator<BridgeEvent> {
    if (this.invalidCallLimitError) {
      yield { type: "failed", error: this.invalidCallLimitError };
      return;
    }
    if (!this.outcome) {
      yield {
        type: "failed",
        error: new SdkQueryError("terminal-result", "query ended without a result message"),
      };
      return;
    }
    this.recordUsage();
    if (this.deferredCalls.size === 0) {
      yield { type: "done", reason: this.outcome.stopReason };
      return;
    }
    yield* this.deferredCallEvents();
  }

  private recordUsage(): void {
    if (this.diagnosticTurn !== undefined && this.latestUsage) {
      this.dependencies.cacheDiagnostics?.usage(this.diagnosticTurn, this.latestUsage);
    }
  }

  private async *deferredCallEvents(): AsyncGenerator<BridgeEvent> {
    if (this.outcome?.terminalReason !== "tool_deferred") {
      yield {
        type: "failed",
        error: new SdkProtocolError(
          "result",
          `captured deferred calls but terminal_reason was ${this.outcome?.terminalReason ?? "missing"}`,
        ),
      };
      return;
    }
    for (const call of this.deferredCalls.values()) {
      yield { type: "tool_call", id: call.id, name: call.name, arguments: { ...call.arguments } };
    }
  }
}

function usageValue(value: number | undefined, previous: number): number {
  return value === undefined ? previous : value;
}

/** Create a stateless Claude Agent SDK runner. */
export function createClaudeAgentSdkRunner(
  runSdkQuery: RunSdkQuery = query,
  cacheDiagnostics?: CacheDiagnosticTracker,
  sdkEnvironment: Readonly<Record<string, string | undefined>> = subscriptionEnvironment(),
): AgentSdkRun {
  const dependencies: TurnDependencies = { runSdkQuery, cacheDiagnostics, sdkEnvironment };
  return (request, model, options) =>
    new ClaudeSdkTurn(request, model, options, dependencies).run();
}
