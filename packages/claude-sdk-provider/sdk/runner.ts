import process from "node:process";
import { createSdkMcpServer, query } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Result } from "effect";
import { absurd } from "effect/Function";
import type { AgentRequest } from "../agent-request";
import type { AgentSdkRun, BridgeEvent, DeferredCall, TokenUsage } from "../bridge";
import type { CacheDiagnosticTracker } from "../cache-tracker";
import { sdkModelSelectorFor } from "../models";
import { createDeferredCallCapture, createDeferredPiCallTool } from "./deferred-tools";
import type { DeferredCallCapture } from "./deferred-tools";
import { SdkMissingResultError, SdkProtocolError, SdkQueryError, SdkResultError } from "./errors";
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
  apiError: string | undefined,
): BridgeEvent {
  if (!result) {
    return failed(new SdkMissingResultError());
  }
  if (result._tag === "failed") {
    const { terminalReason, detail } = result.error;
    return failed(
      apiError === undefined
        ? result.error
        : new SdkResultError({ terminalReason, detail, apiError }),
    );
  }
  const deferred = result.terminalReason === "tool_deferred";
  if (deferred && calls.length === 0) {
    const detail = "terminal_reason was tool_deferred but the PreToolUse hook captured no calls";
    return failed(new SdkProtocolError({ messageType: "result", detail }));
  }
  if (!deferred && calls.length > 0) {
    const detail = `captured deferred calls but terminal_reason was ${result.terminalReason ?? "missing"}`;
    return failed(new SdkProtocolError({ messageType: "result", detail }));
  }
  return deferred ? { type: "tool_calls", calls } : { type: "done", reason: result.stopReason };
}

/** What one SDK query has reported so far. */
type QueryProgress = {
  readonly usage: TokenUsage | undefined;
  /** The first main-loop model of the turn; later model calls may be auxiliary. */
  readonly observedModel: string | undefined;
  readonly result: Extract<SdkMessage, { type: "result" }> | undefined;
  /** The first typed API error an assistant message reported, such as `authentication_failed`. */
  readonly apiError: string | undefined;
};

/** How one SDK query ended. */
type QueryOutcome = Result.Result<QueryProgress, SdkRunError>;

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
      const apiError = progress.apiError ?? message.apiError;
      return {
        progress: { ...progress, usage, observedModel, apiError },
        event: { type: "usage", usage },
      };
    }
    case "result": {
      return { progress: { ...progress, result: message }, event: undefined };
    }
    case "ignored": {
      return { progress, event: undefined };
    }
    default: {
      return absurd(message);
    }
  }
}

// Yields the turn's deltas and running usage, and returns how the query ended.
async function* streamQuery(
  messages: AsyncIterable<unknown>,
  capture: DeferredCallCapture,
  signal: AbortSignal,
): AsyncGenerator<BridgeEvent, QueryOutcome> {
  let progress: QueryProgress = {
    usage: undefined,
    observedModel: undefined,
    result: undefined,
    apiError: undefined,
  };
  try {
    for await (const raw of messages) {
      if (capture.limitError) {
        break;
      }
      const parsed = parseSdkMessage(raw);
      if (Result.isFailure(parsed)) {
        return Result.fail(parsed.failure);
      }
      const { progress: next, event } = advance(progress, parsed.success);
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
      return Result.fail(iterationFailure(capture, signal, error));
    }
  }
  return capture.limitError ? Result.fail(capture.limitError) : Result.succeed(progress);
}

// Why iterating the query threw: the tool-call limit's own abort, a caller cancel, or the SDK.
function iterationFailure(
  capture: DeferredCallCapture,
  signal: AbortSignal,
  error: unknown,
): SdkRunError {
  if (capture.limitError) {
    return capture.limitError;
  }
  return signal.aborted
    ? SdkQueryError.cancelled("iterate", error)
    : SdkQueryError.fromCause("iterate", error);
}

async function* runTurn(
  { runSdkQuery, sdkEnvironment, cacheDiagnostics, modelObserver }: Collaborators,
  turn: Turn,
): AsyncGenerator<BridgeEvent> {
  const { request, model, options } = turn;
  const signal = options?.signal;
  if (signal?.aborted === true) {
    yield failed(SdkQueryError.cancelled("start", signal.reason));
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
      yield failed(SdkQueryError.fromCause("start", error));
      return;
    }

    const ended = yield* streamQuery(messages, capture, abortController.signal);
    if (Result.isFailure(ended)) {
      yield failed(ended.failure);
      return;
    }
    const { usage, observedModel, result, apiError } = ended.success;
    if (result !== undefined && observedModel !== undefined) {
      modelObserver?.({
        selector: sdkModelSelectorFor(model.id),
        canonicalModel: observedModel,
        contextWindow: contextWindowFor(result.modelUsage, observedModel),
      });
    }
    const terminal = terminalEvent(result?.result, capture.calls, apiError);
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
