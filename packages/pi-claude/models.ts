import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const subscriptionCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const adaptiveEffortLevels = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} as const;

const fableEffortLevels = { off: null, xhigh: "xhigh", max: "max" } as const;
const DATE_SUFFIX = /-\d{8}$/u;

export type ChatModelConfig = Extract<ProviderModelConfig, { readonly type?: "chat" }>;

export type SdkModelConfig = {
  readonly sdkModel: string;
  readonly canonicalModel: string;
  readonly minimumCacheableTokens: number;
} & ChatModelConfig;

export const models: readonly SdkModelConfig[] = [
  {
    id: "claude-5.5-sonnet",
    name: "Claude Sonnet 5.5 (official Agent SDK)",
    sdkModel: "sonnet",
    canonicalModel: "claude-sonnet-5-5",
    minimumCacheableTokens: 512,
    reasoning: true,
    thinkingLevelMap: adaptiveEffortLevels,
    input: ["text", "image"],
    cost: subscriptionCost,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: "claude-5.5-opus",
    name: "Claude Opus 5.5 (official Agent SDK)",
    sdkModel: "opus",
    canonicalModel: "claude-opus-5-5",
    minimumCacheableTokens: 512,
    reasoning: true,
    thinkingLevelMap: adaptiveEffortLevels,
    input: ["text", "image"],
    cost: subscriptionCost,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: "claude-5.2-fable",
    name: "Claude Fable 5.2 (official Agent SDK)",
    sdkModel: "claude-fable-5-2",
    canonicalModel: "claude-fable-5-2",
    minimumCacheableTokens: 512,
    reasoning: true,
    thinkingLevelMap: fableEffortLevels,
    input: ["text", "image"],
    cost: subscriptionCost,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: "claude-5.5-haiku",
    name: "Claude Haiku 5.5 (official Agent SDK)",
    sdkModel: "haiku",
    canonicalModel: "claude-haiku-5-5",
    minimumCacheableTokens: 512,
    reasoning: true,
    thinkingLevelMap: adaptiveEffortLevels,
    input: ["text", "image"],
    cost: subscriptionCost,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: "claude-4.5-haiku",
    name: "Claude Haiku 4.5 (official Agent SDK)",
    sdkModel: "claude-haiku-4-5",
    canonicalModel: "claude-haiku-4-5",
    minimumCacheableTokens: 4096,
    reasoning: true,
    input: ["text", "image"],
    cost: subscriptionCost,
    contextWindow: 200_000,
    maxTokens: 32_000,
  },
];

export function providerModel({
  sdkModel: _sdkModel,
  canonicalModel: _canonicalModel,
  minimumCacheableTokens: _minimumCacheableTokens,
  ...model
}: SdkModelConfig): ChatModelConfig {
  return model;
}

export function sdkModelSelectorFor(piModelId: string): string {
  return models.find((model) => model.id === piModelId)?.sdkModel ?? piModelId;
}

export function undatedModelId(modelId: string): string {
  return modelId.replace(DATE_SUFFIX, "");
}

// https://platform.claude.com/docs/en/build-with-claude/prompt-caching#cache-limitations
const otherCacheMinimums = new Map(
  Object.entries({
    "claude-fable-5": 512,
    "claude-fable-5-1": 512,
    "claude-mythos-5-2": 512,
    "claude-mythos-5": 512,
    "claude-mythos-5-1": 512,
    "claude-opus-5": 512,
    "claude-mythos-preview": 2048,
    "claude-opus-4-7": 2048,
    "claude-opus-4-5": 4096,
    "claude-opus-4-6": 4096,
    "claude-opus-4-8": 1024,
    "claude-sonnet-5": 1024,
    "claude-sonnet-4-6": 1024,
    "claude-sonnet-4-5": 1024,
    "claude-opus-4-1": 1024,
    "claude-opus-4": 1024,
    "claude-sonnet-4": 1024,
    "claude-3-5-haiku": 2048,
  }),
);

export function minimumCacheableTokensFor(modelId: string): number | undefined {
  const id = undatedModelId(modelId.replace(/^claude(?:-sdk)?\//u, ""));
  const registered = models.find(
    (model) => model.id === id || model.sdkModel === id || model.canonicalModel === id,
  );
  return registered?.minimumCacheableTokens ?? otherCacheMinimums.get(id);
}

export function formatModelStatus(observed: ReadonlyMap<string, string>): string {
  const lines = models.map((model) => {
    const seen = observed.get(model.sdkModel);
    const mismatch =
      seen !== undefined && undatedModelId(seen) !== model.canonicalModel
        ? ` (expected ${model.canonicalModel})`
        : "";
    return `  ${model.id} → ${model.sdkModel} → ${seen ?? "not observed yet"}${mismatch}`;
  });
  return ["Models:", ...lines].join("\n");
}
