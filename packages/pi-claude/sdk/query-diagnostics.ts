import { models, undatedModelId } from "../models";
import type { ModelUsage } from "./messages";
import { safeApiError } from "./result-failure";

export type QueryModelDiagnostic = {
  readonly model: string;
  readonly canonicalModel?: string;
  readonly input?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly promptTokens?: number;
};

export type QueryDiagnostics = {
  readonly outcome: "completed" | "failed";
  readonly numTurns?: number;
  readonly modelRequests?: number;
  readonly models: readonly QueryModelDiagnostic[];
  readonly modelEntriesOmitted: number;
  readonly apiError?: string;
  readonly assistantToolUses: number;
  readonly maxAssistantToolUses: number;
  readonly errorToolResults: number;
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
