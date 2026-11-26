import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createJiti } from "jiti";
import type { SdkModelConfig } from "../../../../packages/pi-claude/models";

const jiti = createJiti(import.meta.url);

export function snapshotLoader(packageDir: string) {
  return async function load<M>(file: string): Promise<M> {
    return jiti.import<M>(pathToFileURL(path.join(packageDir, file)).href);
  };
}

export function snapshotModel(entry: SdkModelConfig): Model<Api> {
  const { thinkingLevelMap, inputLimits, promptCache, compat, ...config } = entry;
  const model: Model<Api> = {
    ...config,
    api: "claude",
    provider: "claude",
    baseUrl: "agent-sdk://local-claude-code",
  };

  if (thinkingLevelMap !== undefined) {
    model.thinkingLevelMap = thinkingLevelMap;
  }

  if (inputLimits !== undefined) {
    model.inputLimits = inputLimits;
  }

  if (promptCache !== undefined) {
    model.promptCache = promptCache;
  }

  if (compat !== undefined) {
    model.compat = compat;
  }

  return model;
}
