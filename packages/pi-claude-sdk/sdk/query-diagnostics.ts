import { models, undatedModelId } from "../models";
import type { ModelUsage } from "./messages";
import { safeApiError } from "./result-failure";

/** Bounded per-model totals, separate from authoritative main-loop result.usage. */
export type QueryModelDiagnostic = {
  /** Known public model id/alias, or a query-local unknown-N label (never a raw custom name). */
  readonly model: string;
  readonly canonicalModel?: string;
  readonly input?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  /** Present only when all three prompt counts are available and their sum is safe. */
  readonly promptTokens?: number;
};

/** Safe query metadata only: no message text, tool ids/names, arguments, errors or SDK objects. */
export type QueryDiagnostics = {
  readonly outcome: "completed" | "failed";
  /** SDK turn indicator; internal tool-result messages can increment it too. */
  readonly numTurns?: number;
  /** Distinct streamed main-loop message_start events; not auxiliary HTTP requests. */
  readonly modelRequests?: number;
  /** All query-pipeline calls, including side models; not a replacement for result.usage. */
  readonly models: readonly QueryModelDiagnostic[];
  readonly modelEntriesOmitted: number;
  /** Typed SDK API error enum only. Authentication takes precedence over earlier errors. */
  readonly apiError?: string;
  readonly assistantToolUses: number;
  readonly maxAssistantToolUses: number;
  readonly errorToolResults: number;
  readonly hookDeniedCalls: number;
  /** Captured rejection categories; no requested names or hook messages are retained. */
  readonly invalidGatewayCalls: number;
  readonly unexpectedToolCalls: number;
  readonly uncapturedBatchCalls?: number;
  readonly sdkRejectedCalls?: number;
  readonly fallbackCalls: number;
};

const MAX_MODEL_ENTRIES = 8;
const PUBLIC_MODELS = new Set(
  models.flatMap(({ id, sdkModel, canonicalModel }) => [id, sdkModel, canonicalModel]),
);

function publicModel(name: string): string | undefined {
  const undated = undatedModelId(name);
  return PUBLIC_MODELS.has(undated) ? undated : undefined;
}

function safeCount(count: number | undefined): number | undefined {
  return count !== undefined && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

/**
 * Bound and sanitize already-parsed query metadata before passing it to the existing opt-in sink.
 * Unknown names are positional labels: not truncated text, hashes, or other persistent identifiers.
 */
export function queryDiagnostics(
  metadata: Omit<QueryDiagnostics, "models" | "modelEntriesOmitted"> & {
    readonly modelUsage: ModelUsage;
  },
): QueryDiagnostics {
  const { modelUsage, apiError, ...counters } = metadata;
  const entries = Object.entries(modelUsage);
  const safeError = safeApiError(apiError);
  return {
    ...counters,
    ...(safeError === undefined ? {} : { apiError: safeError }),
    models: entries.slice(0, MAX_MODEL_ENTRIES).map(([key, usage], index) => {
      const model = publicModel(key) ?? `unknown-${index + 1}`;
      const canonicalModel =
        usage.canonicalModel === undefined ? undefined : publicModel(usage.canonicalModel);
      const input = safeCount(usage.inputTokens);
      const cacheRead = safeCount(usage.cacheReadInputTokens);
      const cacheWrite = safeCount(usage.cacheCreationInputTokens);
      const promptTokens =
        input === undefined || cacheRead === undefined || cacheWrite === undefined
          ? undefined
          : safeCount(input + cacheRead + cacheWrite);
      return {
        model,
        ...(canonicalModel === undefined ? {} : { canonicalModel }),
        ...(input === undefined ? {} : { input }),
        ...(cacheRead === undefined ? {} : { cacheRead }),
        ...(cacheWrite === undefined ? {} : { cacheWrite }),
        ...(promptTokens === undefined ? {} : { promptTokens }),
      };
    }),
    modelEntriesOmitted: Math.max(0, entries.length - MAX_MODEL_ENTRIES),
  };
}
