import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import type { ModelRef, PromptPlan, PromptSnapshot, TranscriptMessage } from "./prompt-epoch";
import { isInPrompt } from "./prompt-view";
import type { PromptResource } from "./prompt-view";
import type { ResourcePath } from "./resource-path";
import { compareText } from "./toggle-note";

const CACHE_DEBUG_ENV = "PI_SKILLS_CACHE_DEBUG";
const LEGACY_CACHE_DEBUG_ENV = "PI_SKILL_TOGGLE_CACHE_DEBUG";

export type DebugSink = (
  record:
    | {
        readonly type: "discover";
        readonly cwd: string;
        readonly contributed: number;
        readonly durationMs: number;
      }
    | ReturnType<typeof runRecord>
    | NonNullable<ReturnType<typeof usageRecord>>,
) => void;

export function cacheDebugValue(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  return env[CACHE_DEBUG_ENV] ?? env[LEGACY_CACHE_DEBUG_ENV];
}

export function debugPath(
  value: string | undefined,
  agentDir: () => string = getAgentDir,
): string | undefined {
  if (value === undefined || value === "" || value === "0") {
    return undefined;
  }
  return value === "1" ? join(agentDir(), "pi-skills-cache-debug.jsonl") : value;
}

export function cacheDebugSink(
  value: string | undefined = cacheDebugValue(),
  append: (path: string, data: string) => void = appendFileSync,
): DebugSink | undefined {
  const path = debugPath(value);
  if (path === undefined) {
    return undefined;
  }
  return (record) => {
    try {
      append(path, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
      return true;
    } catch {
      return false;
    }
  };
}

export function fingerprint(lines: readonly string[]): string {
  return createHash("sha256").update(lines.join("\0")).digest("hex").slice(0, 16);
}

export type RunDiagnostics = {
  readonly sessionId: string;
  readonly model: ModelRef | undefined;
  readonly snapshot: PromptSnapshot;
  readonly plan: PromptPlan;
  readonly resources: readonly PromptResource[];
  readonly desiredHidden: ReadonlySet<ResourcePath> | undefined;
  readonly options: BuildSystemPromptOptions;
  readonly durationMs: number;
};

export function runRecord(run: RunDiagnostics) {
  const { snapshot, plan } = run;
  return {
    type: "run" as const,
    sessionId: run.sessionId,
    model: modelName(run.model),
    epoch: snapshot.epoch,
    stateLoad: run.desiredHidden === undefined ? "failed" : "ok",
    toggleResources: run.resources.length,
    desiredHidden: sorted(run.desiredHidden ?? []),
    promptHidden: sorted(plan.hidden),
    inPromptBefore: run.resources.filter((resource) => isInPrompt(snapshot.sections, resource))
      .length,
    note:
      plan.note === undefined
        ? null
        : {
            enabled: sorted(plan.changes.enabled.map(({ id }) => id)),
            disabled: sorted(plan.changes.disabled.map(({ id }) => id)),
            chars: plan.note.content.length,
          },
    skillsFingerprint: fingerprint(
      (run.options.skills ?? []).map((skill) => `${skill.filePath}\n${skill.description}`),
    ),
    contextFingerprint: fingerprint(
      (run.options.contextFiles ?? []).map((file) => `${file.path}\n${file.content}`),
    ),
    durationMs: run.durationMs,
  };
}

const isUsageMessage = Schema.is(
  Schema.Struct({
    role: Schema.Literal("assistant"),
    provider: Schema.String,
    model: Schema.String,
    usage: Schema.Struct({
      input: Schema.Number,
      output: Schema.Number,
      cacheRead: Schema.Number,
      cacheWrite: Schema.Number,
    }),
  }),
);

export function usageRecord(message: TranscriptMessage, sessionId: string) {
  if (!isUsageMessage(message)) {
    return undefined;
  }
  const { input, output, cacheRead, cacheWrite } = message.usage;
  const promptTokens = input + cacheRead + cacheWrite;
  return {
    type: "usage" as const,
    sessionId,
    model: `${message.provider}/${message.model}`,
    input,
    output,
    cacheRead,
    cacheWrite,
    promptTokens,
    cacheReadPercent: promptTokens === 0 ? 0 : Math.round((cacheRead / promptTokens) * 1000) / 10,
  };
}

function modelName(model: ModelRef | undefined): string | null {
  return model === undefined ? null : `${model.provider}/${model.id}`;
}

function sorted(ids: Iterable<string>): readonly string[] {
  return [...ids].toSorted(compareText);
}
