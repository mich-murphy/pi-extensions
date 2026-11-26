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
  readonly models: ReadonlyArray<QueryModelDiagnostic>;
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

type ModelDiagnostic = { -readonly [Key in keyof QueryModelDiagnostic]: QueryModelDiagnostic[Key] };

function modelDiagnostic(
  key: string,
  usage: ModelUsage[string],
  index: number,
): QueryModelDiagnostic {
  const diagnostic: ModelDiagnostic = { model: publicModel(key) ?? `unknown-${index + 1}` };

  const canonicalModel =
    usage.canonicalModel === undefined ? undefined : publicModel(usage.canonicalModel);

  if (canonicalModel !== undefined) {
    diagnostic.canonicalModel = canonicalModel;
  }

  const input = safeCount(usage.inputTokens);
  const cacheRead = safeCount(usage.cacheReadInputTokens);
  const cacheWrite = safeCount(usage.cacheCreationInputTokens);

  if (input !== undefined) {
    diagnostic.input = input;
  }

  if (cacheRead !== undefined) {
    diagnostic.cacheRead = cacheRead;
  }

  if (cacheWrite !== undefined) {
    diagnostic.cacheWrite = cacheWrite;
  }

  if (input !== undefined && cacheRead !== undefined && cacheWrite !== undefined) {
    const promptTokens = safeCount(input + cacheRead + cacheWrite);

    if (promptTokens !== undefined) {
      diagnostic.promptTokens = promptTokens;
    }
  }

  return diagnostic;
}

type ApiErrorDiagnostic = { apiError?: string };

export function queryDiagnostics(
  metadata: Omit<QueryDiagnostics, "models" | "modelEntriesOmitted"> & {
    readonly modelUsage: ModelUsage;
  },
): QueryDiagnostics {
  const { modelUsage, apiError, ...counters } = metadata;
  const entries = Object.entries(modelUsage);
  const safeError = safeApiError(apiError);
  const report: ApiErrorDiagnostic = {};

  if (safeError !== undefined) {
    report.apiError = safeError;
  }

  return {
    ...counters,
    ...report,
    models: entries
      .slice(0, MAX_MODEL_ENTRIES)
      .map(([key, usage], index) => modelDiagnostic(key, usage, index)),
    modelEntriesOmitted: Math.max(0, entries.length - MAX_MODEL_ENTRIES),
  };
}
