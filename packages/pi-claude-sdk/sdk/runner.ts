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
import { sdkModelSelectorFor, undatedModelId } from "../models";
import { createDeferredCallCapture, createDeferredPiTools } from "./deferred-tools";
import type { DeferredCallCapture } from "./deferred-tools";
import {
  SdkMissingResultError,
  SdkProtocolError,
  SdkQueryError,
  SdkResultError,
  SdkToolContractError,
} from "./errors";
import type { SdkRunError } from "./errors";
import { instrumentEvent, instrumentRequest } from "./instrumentation";
import { applyUsage, contextWindowFor, maxOutputTokensFor, parseSdkMessage } from "./messages";
import type { SdkMessage, TurnResult } from "./messages";
import { buildPromptStream, cacheTtlFor } from "./prompt-stream";
import type { CacheTtl } from "./prompt-stream";
import { queryDiagnostics } from "./query-diagnostics";
import { effectiveResultCategory } from "./result-failure";
import { subscriptionEnvironment } from "./subscription-environment";
import { compileToolCatalog } from "./tool-catalog";
import type { CatalogTool } from "./tool-catalog";

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
  /** Maximum output the SDK reports for this model, when available. */
  readonly maxOutputTokens: number | undefined;
};

/** Runner collaborators. Each falls back to production behaviour. */
export type RunnerOptions = {
  readonly runSdkQuery?: RunSdkQuery;
  /** Opt in only with the reserved validation-error tool and fail-safe guard installed. */
  readonly validationRecovery?: "pi-tool-loop";
  /** Injectable in-process MCP server factory; defaults to the installed SDK. */
  readonly createMcpServer?: typeof createSdkMcpServer;
  readonly sdkEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly cacheDiagnostics?: CacheDiagnosticTracker | undefined;
  /** Receives the model usage observed on a terminal SDK result. */
  readonly modelObserver?: (observation: ModelObservation) => void;
  /**
   * Receives the reset time when a turn fails on a subscription usage limit that reported one.
   * A throw or rejection is ignored: notifying listeners never changes the turn's outcome.
   */
  readonly usageLimitObserver?: (limit: UsageLimitObservation) => void | Promise<void>;
};

/** A subscription usage limit that ended a turn. */
export type UsageLimitObservation = {
  /** When the rejected window reopens, in epoch milliseconds. */
  readonly resetsAt: number;
};

type SdkQueryParameters = Parameters<RunSdkQuery>[0];
type Collaborators = RunnerOptions &
  Required<Pick<RunnerOptions, "runSdkQuery" | "sdkEnvironment" | "createMcpServer">>;

function failed(error: SdkRunError): BridgeEvent {
  return { type: "failed", error };
}

type Turn = {
  readonly request: AgentRequest;
  readonly model: Model<Api>;
  readonly options: SimpleStreamOptions | undefined;
};

type QueryWiring = {
  readonly abortController: AbortController;
  readonly hook: HookCallback;
  readonly batchHook: HookCallback;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly ttl: CacheTtl;
  readonly onFallback: () => void;
  readonly createMcpServer: typeof createSdkMcpServer;
  readonly catalog: readonly CatalogTool[];
};

/** Local contract failures outrank SDK cancellation caused by our own abort. */
type QueryCapture = {
  readonly deferred: DeferredCallCapture;
  readonly fallbackCalls: number;
  readonly error: SdkRunError | undefined;
  readonly onFallback: () => void;
};

function createQueryCapture(
  catalog: readonly CatalogTool[],
  controller: AbortController,
  validationRecovery: RunnerOptions["validationRecovery"],
): QueryCapture {
  const deferred = createDeferredCallCapture(catalog);
  let fallbackCalls = 0;
  let fallbackError: SdkResultError | undefined;
  return {
    deferred,
    get fallbackCalls() {
      return fallbackCalls;
    },
    get error() {
      return (
        fallbackError ??
        (validationRecovery === undefined &&
        deferred.invalidGatewayCalls +
          deferred.unexpectedToolCalls +
          deferred.uncapturedBatchCalls +
          deferred.sdkRejectedCalls >
          0
          ? new SdkResultError({
              terminalReason: "tool_deferred_unavailable",
              category: "tool-contract",
            })
          : undefined)
      );
    },
    onFallback: () => {
      fallbackCalls += 1;
      fallbackError ??= new SdkResultError({
        terminalReason: "tool_deferred_unavailable",
        category: "tool-contract",
      });
      controller.abort(fallbackError);
    },
  };
}

const thinkingBudgets = { minimal: 1024, low: 2048, medium: 8192, high: 16_384 } as const;

const SESSION_TITLE = "Pi Coding Agent turn";
// Pi owns the outer loop, but SDK validation errors can retry before our hook runs.
// One is unsafe for clean deferral; this is a last-resort bound, not a normal turn budget.
const MAX_SDK_TURNS_PER_QUERY = 8;

function reasoningOptions({
  model,
  options,
}: Turn): Pick<NonNullable<SdkQueryParameters["options"]>, "thinking" | "effort"> {
  if (!model.reasoning) {
    return {};
  }
  const reasoning = options?.reasoning;
  // Haiku 4.5 supports manual thinking, not effort. Recognize custom models using
  // its canonical/snapshot selector too, not only our Pi-facing versioned ID.
  if (undatedModelId(sdkModelSelectorFor(model.id)) === "claude-haiku-4-5") {
    if (!reasoning) {
      return { thinking: { type: "disabled" } };
    }
    const level = reasoning === "xhigh" || reasoning === "max" ? "high" : reasoning;
    const requested = options?.thinkingBudgets?.[level];
    const budget =
      requested !== undefined && Number.isFinite(requested) ? requested : thinkingBudgets[level];
    return {
      thinking: {
        type: "enabled",
        budgetTokens: Math.max(1024, Math.min(Math.floor(budget), model.maxTokens - 1024)),
      },
    };
  }
  return reasoning ? { effort: reasoning === "minimal" ? "low" : reasoning } : {};
}

function queryParameters(
  turn: Turn,
  { abortController, hook, batchHook, env, ttl, onFallback, createMcpServer, catalog }: QueryWiring,
): SdkQueryParameters {
  const { request, model } = turn;
  const server = createMcpServer({
    name: "pi",
    version: "0.1.0",
    tools: [],
    alwaysLoad: true,
  });
  for (const definition of createDeferredPiTools(catalog, onFallback)) {
    server.instance.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.inputSchema,
        _meta: { "anthropic/alwaysLoad": true },
      },
      definition.handler,
    );
  }
  return {
    prompt: buildPromptStream(request.promptBlocks, request.cacheBreakpoints, ttl),
    options: {
      abortController,
      cwd: process.cwd(),
      model: sdkModelSelectorFor(model.id),
      ...reasoningOptions(turn),
      includePartialMessages: true,
      persistSession: false,
      maxTurns: MAX_SDK_TURNS_PER_QUERY,
      // A fixed title skips Claude Code's per-query session-titling request, which would
      // otherwise resend the whole transcript uncached on every stateless Pi turn.
      title: SESSION_TITLE,
      systemPrompt: request.systemPrompt,
      settingSources: [],
      tools: [],
      mcpServers: { pi: server },
      env: { ...env },
      hooks: { PreToolUse: [{ hooks: [hook] }], PostToolBatch: [{ hooks: [batchHook] }] },
    },
  };
}

function terminalEvent(
  result: TurnResult | undefined,
  calls: readonly DeferredCall[],
  apiError: string | undefined,
  batchStopped = false,
): BridgeEvent {
  if (!result) {
    return failed(new SdkMissingResultError());
  }
  if (result._tag === "failed") {
    const { terminalReason, category } = result.error;
    return failed(
      apiError === undefined
        ? result.error
        : new SdkResultError({ terminalReason, category, apiError }),
    );
  }
  if (batchStopped && calls.length === 0) {
    return failed(
      new SdkProtocolError({
        messageType: "result",
        detail: "stopped batch had no recoverable calls",
      }),
    );
  }
  const deferred =
    result.stopReason === "stop" &&
    (result.terminalReason === "tool_deferred" ||
      (batchStopped && result.terminalReason === "hook_stopped"));
  if (deferred && calls.length === 0) {
    const detail = "tool handoff terminal result captured no calls";
    return failed(new SdkProtocolError({ messageType: "result", detail }));
  }
  if (!deferred && calls.length > 0) {
    const detail = `captured deferred calls but terminal_reason was ${result.terminalReason ?? "missing"}`;
    return failed(new SdkProtocolError({ messageType: "result", detail }));
  }
  return deferred ? { type: "tool_calls", calls } : { type: "done", reason: result.stopReason };
}

type QueryProgress = {
  readonly usage: TokenUsage | undefined;
  readonly observedModel: string | undefined;
  readonly result: Extract<SdkMessage, { type: "result" }> | undefined;
  readonly apiError: string | undefined;
  readonly usageLimitResetsAt: number | undefined;
  readonly assistantToolUses: number;
  readonly modelRequests: number;
  readonly modelRequestIds: ReadonlySet<string>;
  readonly errorToolResults: number;
  readonly maxAssistantToolUses: number;
};

type QueryOutcome = Result.Result<QueryProgress, SdkRunError>;

/** Request ids stay query-local; raw numTurns can also count tool-result messages. */
function modelRequestProgress(
  progress: QueryProgress,
  start: Extract<SdkMessage, { type: "usage" }>["modelRequestStart"],
): Pick<QueryProgress, "modelRequests" | "modelRequestIds"> {
  const id = start?.id;
  const started = start !== undefined && (id === undefined || !progress.modelRequestIds.has(id));
  const ids = new Set(progress.modelRequestIds);
  if (id !== undefined) {
    ids.add(id);
  }
  return { modelRequests: progress.modelRequests + (started ? 1 : 0), modelRequestIds: ids };
}

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
      // Authentication must not be hidden by an earlier transient rate-limit error.
      const apiError =
        effectiveResultCategory("provider", message.apiError) === "authentication"
          ? message.apiError
          : (progress.apiError ?? message.apiError);
      return {
        progress: {
          ...progress,
          ...modelRequestProgress(progress, message.modelRequestStart),
          usage,
          observedModel,
          apiError,
          assistantToolUses: progress.assistantToolUses + (message.assistantToolUses ?? 0),
          maxAssistantToolUses: Math.max(
            progress.maxAssistantToolUses,
            message.assistantToolUses ?? 0,
          ),
        },
        event: { type: "usage", usage },
      };
    }
    case "result": {
      if (message.usage === undefined) {
        return { progress: { ...progress, result: message }, event: undefined };
      }
      const usage = applyUsage(progress.usage, message.usage, "turn");
      const unchanged =
        progress.usage !== undefined &&
        progress.usage.input === usage.input &&
        progress.usage.output === usage.output &&
        progress.usage.cacheRead === usage.cacheRead &&
        progress.usage.cacheWrite === usage.cacheWrite &&
        progress.usage.cacheWrite1h === usage.cacheWrite1h;
      return {
        progress: { ...progress, usage, result: message },
        event: unchanged ? undefined : { type: "usage", usage },
      };
    }
    case "tool_results": {
      return {
        progress: {
          ...progress,
          errorToolResults: progress.errorToolResults + message.errorToolResults,
        },
        event: undefined,
      };
    }
    case "usage_limit": {
      return { progress: { ...progress, usageLimitResetsAt: message.resetsAt }, event: undefined };
    }
    case "ignored": {
      return { progress, event: undefined };
    }
    default: {
      return absurd(message);
    }
  }
}

type QueryStep =
  | { readonly _tag: "event"; readonly event: BridgeEvent }
  | { readonly _tag: "end"; readonly outcome: QueryOutcome; readonly progress: QueryProgress };

const initialProgress = (): QueryProgress => ({
  usage: undefined,
  observedModel: undefined,
  result: undefined,
  apiError: undefined,
  usageLimitResetsAt: undefined,
  assistantToolUses: 0,
  modelRequests: 0,
  modelRequestIds: new Set(),
  errorToolResults: 0,
  maxAssistantToolUses: 0,
});

function ended(outcome: QueryOutcome, progress: QueryProgress): QueryStep {
  return { _tag: "end", outcome, progress };
}

function settle(
  capture: QueryCapture,
  progress: QueryProgress,
  callerSignal: AbortSignal | undefined,
): QueryStep {
  if (capture.error) {
    return ended(Result.fail(capture.error), progress);
  }
  if (callerSignal?.aborted === true && progress.result?.result._tag !== "failed") {
    return ended(Result.fail(SdkQueryError.cancelled("iterate", callerSignal.reason)), progress);
  }
  return ended(Result.succeed(progress), progress);
}

/**
 * One item read from the SDK: a raw message, the failure that ended iteration, or the end of the
 * SDK's stream. The end is an explicit item rather than mapAccum's onHalt, because onHalt also
 * runs on defects and would report them as a missing result.
 */
type QueryItem = Result.Result<unknown, SdkRunError> | { readonly _tag: "Halted" };

const HALTED: QueryItem = { _tag: "Halted" };

function step(
  capture: QueryCapture,
  callerSignal: AbortSignal | undefined,
): (progress: QueryProgress, item: QueryItem) => readonly [QueryProgress, readonly QueryStep[]] {
  return (progress, item) => {
    if (item._tag === "Halted") {
      return [progress, [settle(capture, progress, callerSignal)]];
    }
    if (capture.error) {
      return [progress, [ended(Result.fail(capture.error), progress)]];
    }
    if (Result.isFailure(item)) {
      return [progress, [ended(Result.fail(item.failure), progress)]];
    }
    const parsed = parseSdkMessage(item.success);
    if (Result.isFailure(parsed)) {
      return [progress, [ended(Result.fail(parsed.failure), progress)]];
    }
    const { progress: next, event } = advance(progress, parsed.success);
    const steps: QueryStep[] = event ? [{ _tag: "event", event }] : [];
    // The prompt is a single message, so its result ends the turn. Stopping
    // here keeps the turn from depending on the SDK closing its stream.
    return [next, next.result ? [...steps, settle(capture, next, callerSignal)] : steps];
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
            return { done: true, value: undefined };
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function querySteps(
  messages: AsyncIterable<unknown>,
  capture: QueryCapture,
  abortController: AbortController,
  turn: Turn,
): Stream.Stream<QueryStep> {
  return Stream.fromAsyncIterable(abortOnClose(messages, abortController), (error) =>
    iterationFailure(capture, abortController.signal, error),
  ).pipe(
    Stream.mapEffect((event) =>
      instrumentEvent(event, turn.model, turn.options, abortController.signal),
    ),
    Stream.result,
    Stream.concat(Stream.succeed(HALTED)),
    Stream.mapAccum(initialProgress, step(capture, turn.options?.signal)),
    Stream.takeUntil((queryStep) => queryStep._tag === "end"),
  );
}

function iterationFailure(capture: QueryCapture, signal: AbortSignal, error: unknown): SdkRunError {
  if (capture.error) {
    return capture.error;
  }
  return signal.aborted
    ? SdkQueryError.cancelled("iterate", error)
    : SdkQueryError.fromCause("iterate", error);
}

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
        controller.abort();
      }),
  ).pipe(Effect.map(({ controller }) => controller));
}

type TurnObservers = {
  readonly selector: string;
  readonly modelObserver: RunnerOptions["modelObserver"];
  readonly usageLimitObserver: RunnerOptions["usageLimitObserver"];
  readonly recordUsage: ReturnType<CacheDiagnosticTracker> | undefined;
};

function conclude(
  outcome: QueryOutcome,
  progress: QueryProgress,
  capture: QueryCapture,
  { selector, modelObserver, usageLimitObserver, recordUsage }: TurnObservers,
): BridgeEvent {
  const { usage, observedModel, result, apiError } = progress;
  if (result !== undefined && observedModel !== undefined) {
    modelObserver?.({
      selector,
      canonicalModel: observedModel,
      contextWindow: contextWindowFor(result.modelUsage, observedModel),
      maxOutputTokens: maxOutputTokensFor(result.modelUsage, observedModel),
    });
  }
  const terminal = Result.isFailure(outcome)
    ? failed(outcome.failure)
    : terminalEvent(
        result?.result,
        capture.deferred.calls,
        apiError,
        capture.deferred.batchStopped,
      );
  const checkedTerminal =
    terminal.type !== "failed" && progress.modelRequests > 1
      ? failed(
          new SdkProtocolError({
            messageType: "result",
            detail: "SDK performed an internal model continuation; Pi owns recovery",
          }),
        )
      : terminal;
  reportUsageLimit(checkedTerminal, progress.usageLimitResetsAt, usageLimitObserver);
  recordUsage?.(usage, {
    ...(observedModel === undefined ? {} : { observedModel }),
    query: queryDiagnostics({
      outcome: checkedTerminal.type === "failed" ? "failed" : "completed",
      ...(result?.numTurns === undefined ? {} : { numTurns: result.numTurns }),
      modelUsage: result?.modelUsage ?? {},
      ...(apiError === undefined ? {} : { apiError }),
      modelRequests: progress.modelRequests,
      assistantToolUses: progress.assistantToolUses,
      maxAssistantToolUses: progress.maxAssistantToolUses,
      errorToolResults: progress.errorToolResults,
      hookDeniedCalls: capture.deferred.hookDeniedCalls,
      invalidGatewayCalls: capture.deferred.invalidGatewayCalls,
      unexpectedToolCalls: capture.deferred.unexpectedToolCalls,
      uncapturedBatchCalls: capture.deferred.uncapturedBatchCalls,
      sdkRejectedCalls: capture.deferred.sdkRejectedCalls,
      fallbackCalls: capture.fallbackCalls,
    }),
  });
  return checkedTerminal;
}

function reportUsageLimit(
  terminal: BridgeEvent,
  resetsAt: number | undefined,
  observer: RunnerOptions["usageLimitObserver"],
): void {
  if (
    resetsAt !== undefined &&
    terminal.type === "failed" &&
    terminal.error._tag === "SdkResultError" &&
    effectiveResultCategory(terminal.error.category, terminal.error.apiError) === "usage-limit"
  ) {
    // Recovery notifications are best effort: a subscriber must not replace the actual failure
    // or prevent query cleanup. Observe async rejections too, without delaying the terminal event.
    try {
      void Promise.resolve(observer?.({ resetsAt })).catch(() => undefined);
    } catch {
      // Do not expose observer exceptions or payloads in provider diagnostics.
    }
  }
}

const runTurn = Effect.fnUntraced(function* (
  {
    runSdkQuery,
    sdkEnvironment,
    cacheDiagnostics,
    modelObserver,
    usageLimitObserver,
    createMcpServer,
    validationRecovery,
  }: Collaborators,
  turn: Turn,
): Effect.fn.Return<Stream.Stream<BridgeEvent>, never, Scope.Scope> {
  const { model, options } = turn;
  const signal = options?.signal;
  if (signal?.aborted === true) {
    return Stream.succeed(failed(SdkQueryError.cancelled("start", signal.reason)));
  }
  const abortController = yield* turnAbortController(signal);
  const applied = yield* Effect.result(
    instrumentRequest(turn.request, model, options, abortController.signal),
  );
  if (Result.isFailure(applied)) {
    return Stream.succeed(failed(applied.failure));
  }
  if (abortController.signal.aborted) {
    return Stream.succeed(failed(SdkQueryError.cancelled("start", undefined)));
  }
  const request = applied.success;
  const appliedTurn = { ...turn, request };
  const compiled = Result.try({
    try: () => compileToolCatalog(request.tools),
    catch: (error) =>
      error instanceof SdkToolContractError
        ? error
        : new SdkToolContractError({ reason: "schema" }),
  });
  if (Result.isFailure(compiled)) {
    return Stream.succeed(failed(compiled.failure));
  }
  const catalog = compiled.success;
  const capture = createQueryCapture(catalog, abortController, validationRecovery);
  const ttl = cacheTtlFor(
    options?.cacheRetention,
    options?.env?.PI_CACHE_RETENTION ?? sdkEnvironment.PI_CACHE_RETENTION,
  );
  const recordUsage = cacheDiagnostics?.(`${model.provider}/${model.id}`, request, {
    ttl,
    reasoning: options?.reasoning,
  });
  const started = Result.try({
    try: () =>
      runSdkQuery(
        queryParameters(appliedTurn, {
          abortController,
          hook: capture.deferred.hook,
          batchHook: capture.deferred.batchHook,
          onFallback: capture.onFallback,
          createMcpServer,
          catalog,
          env: sdkEnvironment,
          ttl,
        }),
      ),
    catch: (error) => SdkQueryError.fromCause("start", error),
  });
  const observers = {
    selector: sdkModelSelectorFor(model.id),
    modelObserver,
    usageLimitObserver,
    recordUsage,
  };
  if (Result.isFailure(started)) {
    return Stream.succeed(
      conclude(
        Result.fail(capture.error ?? started.failure),
        initialProgress(),
        capture,
        observers,
      ),
    );
  }
  return querySteps(started.success, capture, abortController, appliedTurn).pipe(
    Stream.map((queryStep) =>
      queryStep._tag === "event"
        ? queryStep.event
        : conclude(queryStep.outcome, queryStep.progress, capture, observers),
    ),
  );
});

/** Create a stateless Claude Agent SDK runner. */
export function createClaudeAgentSdkRunner(options: RunnerOptions = {}): AgentSdkRun {
  const collaborators: Collaborators = {
    runSdkQuery: query,
    createMcpServer: createSdkMcpServer,
    sdkEnvironment: subscriptionEnvironment(),
    ...options,
  };
  return (request, model, streamOptions) =>
    // Pi consumes a plain AsyncIterable; ending it early runs the stream's finalizers first.
    Stream.toAsyncIterable(
      Stream.unwrap(runTurn(collaborators, { request, model, options: streamOptions })),
    );
}
