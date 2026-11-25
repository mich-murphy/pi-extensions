import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { assert, expect } from "vitest";
import { models, undatedModelId } from "../models";
import type { SdkModelConfig } from "../models";

export function assertModelMetadata(
  supportedModels: readonly ModelInfo[],
  advertisedModels: readonly SdkModelConfig[] = models,
): void {
  for (const entry of advertisedModels) {
    const direct = supportedModels.find(
      (candidate) => undatedModelId(candidate.value) === entry.sdkModel,
    );

    const metadata =
      direct ??
      (undatedModelId(entry.sdkModel) === entry.canonicalModel
        ? supportedModels.find(
            (candidate) =>
              candidate.resolvedModel !== undefined &&
              undatedModelId(candidate.resolvedModel) === entry.canonicalModel,
          )
        : undefined);

    assert(metadata !== undefined, `missing model metadata for ${entry.sdkModel}`);
    assert(metadata.resolvedModel !== undefined, `missing resolution for ${entry.sdkModel}`);
    expect(undatedModelId(metadata.resolvedModel), `${entry.id} metadata resolution`).toBe(
      entry.canonicalModel,
    );

    const {
      supportsAdaptiveThinking = false,
      supportsEffort = false,
      supportedEffortLevels = [],
    } = metadata;

    const adaptive = entry.canonicalModel !== "claude-haiku-4-5";
    expect(
      { supportsAdaptiveThinking, supportsEffort, supportedEffortLevels },
      `${entry.id} native thinking metadata`,
    ).toStrictEqual({
      supportsAdaptiveThinking: adaptive,
      supportsEffort: adaptive,
      supportedEffortLevels: adaptive ? ["low", "medium", "high", "xhigh", "max"] : [],
    });
  }
}
