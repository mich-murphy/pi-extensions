import process from "node:process";
import { createSdkMcpServer, query } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Effect, Result, Stream } from "effect";
import type { Scope } from "effect";
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

/** One step of a query: a streamed event, or how the query ended. */
type QueryStep =
  | { readonly _tag: "event"; readonly event: BridgeEvent }
  | { readonly _tag: "end"; readonly outcome: QueryOutcome };

const initialProgress = (): QueryProgress => ({
  usage: undefined,
  observedModel: undefined,
  result: undefined,
  apiError: undefined,
});

function ended(outcome: QueryOutcome): QueryStep {
  return { _tag: "end", outcome };
}

// The invalid-call limit outranks whatever the query reported once it has been reached.
function settle(capture: DeferredCallCapture, progress: QueryProgress): QueryStep {
  return ended(capture.limitError ? Result.fail(capture.limitError) : Result.succeed(progress));
}

/**
 * One item read from the SDK: a raw message, the failure that ended iteration, or the end of the
 * SDK's stream. The end is an explicit item rather than mapAccum's onHalt, because onHalt also
 * runs on defects and would report them as a missing result.
 */
type QueryItem = Result.Result<unknown, SdkRunError> | { readonly _tag: "Halted" };

const HALTED: QueryItem = { _tag: "Halted" };

// Folds one SDK message, the failure that ended iteration, or the stream's end into the progress.
function step(
  capture: DeferredCallCapture,
): (progress: QueryProgress, item: QueryItem) => readonly [QueryProgress, readonly QueryStep[]] {
  return (progress, item) => {
    if (item._tag === "Halted") {
      return [progress, [settle(capture, progress)]];
    }
    if (Result.isFailure(item)) {
      return [progress, [ended(Result.fail(item.failure))]];
    }
    if (capture.limitError) {
      return [progress, [ended(Result.fail(capture.limitError))]];
    }
    const parsed = parseSdkMessage(item.success);
    if (Result.isFailure(parsed)) {
      return [progress, [ended(Result.fail(parsed.failure))]];
    }
    const { progress: next, event } = advance(progress, parsed.success);
    const steps: QueryStep[] = event ? [{ _tag: "event", event }] : [];
    // The prompt is a single message, so its result ends the turn. Stopping
    // here keeps the turn from depending on the SDK closing its stream.
    return [next, next.result ? [...steps, settle(capture, next)] : steps];
  };
}

/**
 * Closing the stream calls the query's `return()`. Aborting first lets a pending `next()` settle
 * instead of queueing `return()` behind it. A rejection while closing is dropped: by then the
 * turn's outcome is decided or no longer read, and real iteration failures come from `next()`.
 * The SDK iterator is opened on the first `next()`, so a throwing iterator factory becomes an
 * iteration failure rather than a defect.
 */
function abortOnClose(
  messages: AsyncIterable<unknown>,
  abortController: AbortController,
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: () => {
      let iterator: AsyncIterator<unknown> | undefined;
      return {
        next: async () => {
          iterator ??= messages[Symbol.asyncIterator]();
          return iterator.next();
        },
        return: async () => {
          abortController.abort();
          try {
            await iterator?.return?.();
          } catch {
            // Deliberately dropped: see abortOnClose.
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
}

// The turn's deltas and running usage, ending with exactly one step that says how the query ended.
function querySteps(
  messages: AsyncIterable<unknown>,
  capture: DeferredCallCapture,
  abortController: AbortController,
): Stream.Stream<QueryStep> {
  return Stream.fromAsyncIterable(abortOnClose(messages, abortController), (error) =>
    iterationFailure(capture, abortController.signal, error),
  ).pipe(
    Stream.result,
    Stream.concat(Stream.succeed(HALTED)),
    Stream.mapAccum(initialProgress, step(capture)),
    Stream.takeUntil((queryStep) => queryStep._tag === "end"),
  );
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

// The turn's AbortController, which follows Pi's signal and is aborted however the turn ends.
function turnAbortController(
  signal: AbortSignal | undefined,
): Effect.Effect<AbortController, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const controller = new AbortController();
      const forwardAbort = (): void => {
        controller.abort(signal?.reason);
      };
      signal?.addEventListener("abort", forwardAbort, { once: true });
      return { controller, forwardAbort };
    }),
    ({ controller, forwardAbort }) =>
      Effect.sync(() => {
        signal?.removeEventListener("abort", forwardAbort);
        // Stop the SDK subprocess however the turn ended, including an abandoned stream.
        controller.abort();
      }),
  ).pipe(Effect.map(({ controller }) => controller));
}

/** What the runner reports once a query has ended. */
type TurnObservers = {
  readonly selector: string;
  readonly modelObserver: RunnerOptions["modelObserver"];
  readonly recordUsage: ((usage: TokenUsage) => void) | undefined;
};

// The terminal event for a query outcome, reporting the model and usage of a completed turn.
function conclude(
  outcome: QueryOutcome,
  capture: DeferredCallCapture,
  { selector, modelObserver, recordUsage }: TurnObservers,
): BridgeEvent {
  if (Result.isFailure(outcome)) {
    return failed(outcome.failure);
  }
  const { usage, observedModel, result, apiError } = outcome.success;
  if (result !== undefined && observedModel !== undefined) {
    modelObserver?.({
      selector,
      canonicalModel: observedModel,
      contextWindow: contextWindowFor(result.modelUsage, observedModel),
    });
  }
  const terminal = terminalEvent(result?.result, capture.calls, apiError);
  if (terminal.type !== "failed" && usage) {
    recordUsage?.(usage);
  }
  return terminal;
}

const runTurn = Effect.fnUntraced(function* (
  { runSdkQuery, sdkEnvironment, cacheDiagnostics, modelObserver }: Collaborators,
  turn: Turn,
): Effect.fn.Return<Stream.Stream<BridgeEvent>, never, Scope.Scope> {
  const { request, model, options } = turn;
  const signal = options?.signal;
  if (signal?.aborted === true) {
    return Stream.succeed(failed(SdkQueryError.cancelled("start", signal.reason)));
  }
  const abortController = yield* turnAbortController(signal);
  const capture = createDeferredCallCapture(request.toolNames, (limitError) => {
    abortController.abort(limitError);
  });
  const recordUsage = cacheDiagnostics?.(`${model.provider}/${model.id}`, request);
  const started = Result.try({
    try: () =>
      runSdkQuery(
        queryParameters(turn, { abortController, hook: capture.hook, env: sdkEnvironment }),
      ),
    catch: (error) => SdkQueryError.fromCause("start", error),
  });
  if (Result.isFailure(started)) {
    return Stream.succeed(failed(started.failure));
  }
  const observers = { selector: sdkModelSelectorFor(model.id), modelObserver, recordUsage };
  return querySteps(started.success, capture, abortController).pipe(
    Stream.map((queryStep) =>
      queryStep._tag === "event"
        ? queryStep.event
        : conclude(queryStep.outcome, capture, observers),
    ),
  );
});

/** Create a stateless Claude Agent SDK runner. */
export function createClaudeAgentSdkRunner(options: RunnerOptions = {}): AgentSdkRun {
  const collaborators: Collaborators = {
    runSdkQuery: query,
    sdkEnvironment: subscriptionEnvironment(),
    ...options,
  };
  return (request, model, streamOptions) =>
    // Pi consumes a plain AsyncIterable; ending it early runs the stream's finalizers first.
    Stream.toAsyncIterable(
      Stream.unwrap(runTurn(collaborators, { request, model, options: streamOptions })),
    );
}
