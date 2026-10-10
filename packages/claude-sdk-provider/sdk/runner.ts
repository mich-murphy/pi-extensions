import process from "node:process";
import { createSdkMcpServer, query } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AgentRequest } from "../agent-request";
import type { AgentSdkRun, BridgeEvent, DeferredCall, TokenUsage } from "../bridge";
import type { CacheDiagnosticTracker } from "../cache-tracker";
import { sdkModelSelectorFor } from "../models";
import { createDeferredCallCapture, createDeferredPiCallTool } from "./deferred-tools";
import type { DeferredCallCapture } from "./deferred-tools";
import { SdkProtocolError, SdkQueryError } from "./errors";
import type { SdkRunError } from "./errors";
import { applyUsage, contextWindowFor, parseSdkMessage } from "./messages";
import type { SdkMessage, TurnResult } from "./messages";
import { buildPromptStream } from "./prompt-stream";
import { subscriptionEnvironment } from "./subscription-environment";

/** Injectable Claude Agent SDK query function used by the runner and its tests. */
export type RunSdkQuery = (params: Readonly<Parameters<typeof query>[0]>) => AsyncIterable<unknown>;

/** A model resolution observed from a real turn. */
export type ModelObservation = {
  /** Claude Code model selector the request used. */
  readonly selector: string;
  /** Concrete main-loop model id that served the turn, e.g. "claude-fable-5-1". */
  readonly canonicalModel: string;
  /** Context window the request actually ran with, when reported. */
  readonly contextWindow: number | undefined;
};

/** Runner collaborators. Each falls back to production behaviour. */
export type RunnerOptions = {
  readonly runSdkQuery?: RunSdkQuery;
  readonly sdkEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly cacheDiagnostics?: CacheDiagnosticTracker | undefined;
  /** Receives the model usage observed on a terminal SDK result. */
  readonly modelObserver?: (observation: ModelObservation) => void;
};

type SdkQueryParameters = Parameters<RunSdkQuery>[0];
type Collaborators = RunnerOptions &
  Required<Pick<RunnerOptions, "runSdkQuery" | "sdkEnvironment">>;

function failed(error: SdkRunError): BridgeEvent {
  return { type: "failed", error };
}

/** One provider turn as Pi requested it. */
type Turn = {
  readonly request: AgentRequest;
  readonly model: Model<Api>;
  readonly options: SimpleStreamOptions | undefined;
};

/** Per-turn SDK wiring the runner creates before starting the query. */
type QueryWiring = {
  readonly abortController: AbortController;
  readonly hook: HookCallback;
  readonly env: Readonly<Record<string, string | undefined>>;
};

function queryParameters(
  { request, model, options }: Turn,
  { abortController, hook, env }: QueryWiring,
): SdkQueryParameters {
  const reasoning = options?.reasoning;
  const server = createSdkMcpServer({
    name: "pi",
    version: "0.1.0",
    tools: [createDeferredPiCallTool(request.toolDescription)],
    alwaysLoad: true,
  });
  return {
    prompt: buildPromptStream(request.promptBlocks, request.cacheBreakpoint),
    options: {
      abortController,
      cwd: process.cwd(),
      model: sdkModelSelectorFor(model.id),
      // Models without reasoning support, such as Haiku 4.5, reject the effort option.
      ...(model.reasoning && reasoning
        ? { effort: reasoning === "minimal" ? ("low" as const) : reasoning }
        : {}),
      includePartialMessages: true,
      persistSession: false,
      systemPrompt: request.systemPrompt,
      settingSources: [],
      tools: [],
      mcpServers: { pi: server },
      env: { ...env },
      hooks: { PreToolUse: [{ hooks: [hook] }] },
    },
  };
}

// Pi receives deferred calls only after a clean result that confirms the defer,
// and a confirmed defer must have captured the calls it deferred.
function terminalEvent(
  result: TurnResult | undefined,
  calls: readonly DeferredCall[],
): BridgeEvent {
  if (!result) {
    return failed(new SdkQueryError("terminal-result", "query ended without a result message"));
  }
  if (result._tag === "failed") {
    return failed(result.error);
  }
  const deferred = result.terminalReason === "tool_deferred";
  if (deferred && calls.length === 0) {
    const detail = "terminal_reason was tool_deferred but the PreToolUse hook captured no calls";
    return failed(new SdkProtocolError("result", detail));
  }
  if (!deferred && calls.length > 0) {
    const detail = `captured deferred calls but terminal_reason was ${result.terminalReason ?? "missing"}`;
    return failed(new SdkProtocolError("result", detail));
  }
  return deferred ? { type: "tool_calls", calls } : { type: "done", reason: result.stopReason };
}

/** What one SDK query has reported so far. */
type QueryProgress = {
  readonly usage: TokenUsage | undefined;
  /** The first main-loop model of the turn; later model calls may be auxiliary. */
  readonly observedModel: string | undefined;
  readonly result: Extract<SdkMessage, { type: "result" }> | undefined;
};

/** How one SDK query ended. */
type QueryOutcome =
  | { readonly _tag: "ended"; readonly progress: QueryProgress }
  | { readonly _tag: "failed"; readonly error: SdkRunError };

// Folds one SDK message into the progress and returns the bridge event it produces, if any.
function advance(
  progress: QueryProgress,
  message: SdkMessage,
): { readonly progress: QueryProgress; readonly event: BridgeEvent | undefined } {
  switch (message.type) {
    case "text_delta":
    case "thinking_delta": {
      return { progress, event: message };
    }
    case "usage": {
      const usage = applyUsage(progress.usage, message.usage);
      const observedModel = progress.observedModel ?? message.model;
      return { progress: { ...progress, usage, observedModel }, event: { type: "usage", usage } };
    }
    case "result": {
      return { progress: { ...progress, result: message }, event: undefined };
    }
    case "ignored": {
      return { progress, event: undefined };
    }
    default: {
      const _exhaustive: never = message;
      throw new Error("Unhandled SDK message", { cause: _exhaustive });
    }
  }
}

// Yields the turn's deltas and running usage, and returns how the query ended.
async function* streamQuery(
  messages: AsyncIterable<unknown>,
  capture: DeferredCallCapture,
): AsyncGenerator<BridgeEvent, QueryOutcome> {
  let progress: QueryProgress = { usage: undefined, observedModel: undefined, result: undefined };
  try {
    for await (const raw of messages) {
      if (capture.limitError) {
        break;
      }
      const parsed = parseSdkMessage(raw);
      if (parsed._tag === "err") {
        return { _tag: "failed", error: parsed.error };
      }
      const { progress: next, event } = advance(progress, parsed.value);
      progress = next;
      if (event) {
        yield event;
      }
      // The prompt is a single message, so its result ends the turn. Stopping
      // here keeps the turn from depending on the SDK closing its stream.
      if (progress.result) {
        break;
      }
    }
  } catch (error) {
    // A result already in hand outlives a failure while closing the finished query.
    if (!progress.result) {
      return { _tag: "failed", error: capture.limitError ?? new SdkQueryError("iterate", error) };
    }
  }
  return capture.limitError
    ? { _tag: "failed", error: capture.limitError }
    : { _tag: "ended", progress };
}

async function* runTurn(
  { runSdkQuery, sdkEnvironment, cacheDiagnostics, modelObserver }: Collaborators,
  turn: Turn,
): AsyncGenerator<BridgeEvent> {
  const { request, model, options } = turn;
  const signal = options?.signal;
  if (signal?.aborted === true) {
    yield failed(new SdkQueryError("start", signal.reason));
    return;
  }
  const abortController = new AbortController();
  const forwardAbort = (): void => {
    abortController.abort(signal?.reason);
  };
  signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    const capture = createDeferredCallCapture(request.toolNames, (limitError) => {
      abortController.abort(limitError);
    });
    const recordUsage = cacheDiagnostics?.(`${model.provider}/${model.id}`, request);
    let messages: AsyncIterable<unknown>;
    try {
      messages = runSdkQuery(
        queryParameters(turn, { abortController, hook: capture.hook, env: sdkEnvironment }),
      );
    } catch (error) {
      yield failed(new SdkQueryError("start", error));
      return;
    }

    const ended = yield* streamQuery(messages, capture);
    if (ended._tag === "failed") {
      yield failed(ended.error);
      return;
    }
    const { usage, observedModel, result } = ended.progress;
    if (result !== undefined && observedModel !== undefined) {
      modelObserver?.({
        selector: sdkModelSelectorFor(model.id),
        canonicalModel: observedModel,
        contextWindow: contextWindowFor(result.modelUsage, observedModel),
      });
    }
    const terminal = terminalEvent(result?.result, capture.calls);
    if (terminal.type !== "failed" && usage) {
      recordUsage?.(usage);
    }
    yield terminal;
  } finally {
    signal?.removeEventListener("abort", forwardAbort);
    // Stop the SDK subprocess however the turn ended, including an abandoned stream.
    abortController.abort();
  }
}

/** Create a stateless Claude Agent SDK runner. */
export function createClaudeAgentSdkRunner(options: RunnerOptions = {}): AgentSdkRun {
  const collaborators: Collaborators = {
    runSdkQuery: query,
    sdkEnvironment: subscriptionEnvironment(),
    ...options,
  };
  return (request, model, streamOptions) =>
    runTurn(collaborators, { request, model, options: streamOptions });
}
