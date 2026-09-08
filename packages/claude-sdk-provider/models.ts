import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const subscriptionCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DATE_SUFFIX = /-\d{8}$/;

/** Provider model registration plus the Claude Code routing it advertises. */
export interface SdkModelConfig extends ProviderModelConfig {
  /**
   * Claude Code model selector sent to the Agent SDK. Registered models use the
   * documented moving aliases so the underlying model tracks the bundled
   * Claude Code.
   */
  readonly sdkModel: string;
  /**
   * Concrete model the selector resolves to under the pinned Agent SDK, as the
   * SDK names it in `message_start`. The live upgrade gate asserts this.
   */
  readonly canonicalModel: string;
}

/** Models exposed by the official Claude Agent SDK provider. */
export const models: ReadonlyArray<SdkModelConfig> = [
  {
    id: "claude-5-sonnet",
    name: "Claude Sonnet 5 (official Agent SDK)",
    sdkModel: "sonnet",
    canonicalModel: "claude-sonnet-5",
    reasoning: true,
    input: ["text", "image"],
    cost: subscriptionCost,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: "claude-5-opus",
    name: "Claude Opus 5 (official Agent SDK)",
    sdkModel: "opus",
    canonicalModel: "claude-opus-5",
    reasoning: true,
    input: ["text", "image"],
    cost: subscriptionCost,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: "claude-5.1-fable",
    name: "Claude Fable 5.1 (official Agent SDK)",
    sdkModel: "fable",
    canonicalModel: "claude-fable-5-1",
    reasoning: true,
    input: ["text", "image"],
    cost: subscriptionCost,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: "claude-4.5-haiku",
    name: "Claude Haiku 4.5 (official Agent SDK)",
    sdkModel: "haiku",
    canonicalModel: "claude-haiku-4-5",
    reasoning: false,
    input: ["text", "image"],
    cost: subscriptionCost,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
];

/**
 * Strip the routing fields Pi does not know about before registration.
 *
 * @param model - Advertised model with its Claude Code routing.
 * @returns The plain provider model configuration.
 */
export function providerModel({
  sdkModel: _sdkModel,
  canonicalModel: _canonicalModel,
  ...model
}: SdkModelConfig): ProviderModelConfig {
  return model;
}

/**
 * Resolve the Claude Code model selector for a Pi model ID.
 *
 * Registered versioned IDs map to their moving alias. Any other ID passes
 * through unchanged so custom models configured as a Claude Code alias or full
 * model name keep working.
 *
 * @param piModelId - Pi-facing model ID.
 * @returns The model selector to send to the Agent SDK.
 */
export function sdkModelSelectorFor(piModelId: string): string {
  return models.find((model) => model.id === piModelId)?.sdkModel ?? piModelId;
}

/**
 * Drop a trailing `-yyyymmdd` snapshot suffix from a concrete model id.
 *
 * @param modelId - Model id as reported by the SDK.
 * @returns The undated id, e.g. "claude-haiku-4-5".
 */
export function undatedModelId(modelId: string): string {
  return modelId.replace(DATE_SUFFIX, "");
}

/**
 * Format the advertised routing next to what real turns observed for
 * `/claude-sdk-status`.
 *
 * @param observed - Concrete model observed per selector during this process.
 * @returns Human-readable multi-line mapping list.
 */
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
