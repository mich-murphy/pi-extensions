import { createHash } from "node:crypto";
import { Clock, Effect } from "effect";
import { CACHE_LOOKBACK_BLOCKS } from "./agent-request";
import type { AgentRequest, PromptBlock } from "./agent-request";
import type { TokenUsage } from "./bridge";
import { minimumCacheableTokensFor } from "./models";
import type { CacheTtl } from "./sdk/prompt-stream";
import type { QueryDiagnostics } from "./sdk/query-diagnostics";

export type CacheRequestDiagnostic = {
  readonly type: "request";
  readonly turn: number;
  readonly model: string;
  readonly minimumCacheableTokens?: number;
  readonly reasoning?: string;
  readonly ttl: CacheTtl;
  readonly blocks: number;
  readonly textCharacters: number;
  readonly imageBase64Characters: number;
  readonly breakpoints: readonly number[];
  readonly commonPrefixBlocks: number;
  readonly commonPrefixCharacters: number;
  readonly contentFingerprint: string;
  readonly systemFingerprint: string;
  readonly toolsFingerprint?: string;
  readonly reusablePrefixFingerprint?: string;
  readonly prefixChange:
    | "first"
    | "appended"
    | "system-changed"
    | "tools-changed"
    | "history-rewritten"
    | "model-changed"
    | "reasoning-changed";
  readonly msSincePreviousRequest?: number;
};

export type CacheUsageDiagnostic = {
  readonly type: "usage";
  readonly turn: number;
  readonly promptTokens: number;
  readonly query?: QueryDiagnostics;
  readonly minimumCacheableTokens?: number;
  readonly cacheReadPercent: number;
  readonly possibleCollapse: boolean;
  readonly expectedReusableCharacters: number;
  readonly likelyMissCause?:
    | "caching-disabled"
    | "below-minimum"
    | "first"
    | "ttl-expired"
    | "prefix-changed"
    | "lookback";
} & TokenUsage;

export type CacheQueryDiagnostic = {
  readonly type: "query";
  readonly turn: number;
  readonly query: QueryDiagnostics;
};

export type CacheDiagnostic = CacheRequestDiagnostic | CacheUsageDiagnostic | CacheQueryDiagnostic;

export type CacheUsageMetadata = {
  readonly observedModel?: string;
  readonly query?: QueryDiagnostics;
};

export type CacheDiagnosticTracker = (
  model: string,
  request: Pick<AgentRequest, "promptBlocks" | "cacheBreakpoints"> & {
    readonly toolDescription?: string;
  },
  settings?: { readonly ttl?: CacheTtl; readonly reasoning?: string | undefined },
) => (usage: TokenUsage | undefined, metadata?: CacheUsageMetadata) => void;

type PrefixChange = CacheRequestDiagnostic["prefixChange"];
type MissCause = NonNullable<CacheUsageDiagnostic["likelyMissCause"]>;

type BlockStats = {
  readonly digest: string;
  readonly textCharacters: number;
  readonly imageCharacters: number;
  readonly wireBlocks: number;
};

type RequestState = {
  readonly model: string;
  readonly reasoning: string | undefined;
  readonly toolsFingerprint: string | undefined;
  readonly blocks: readonly BlockStats[];
  readonly breakpoints: readonly number[];
  readonly at: number;
};

type MissContext = {
  readonly ttl: CacheTtl;
  readonly prefixChange: PrefixChange;
  readonly msSincePreviousRequest: number | undefined;
  readonly lookbackExceeded: boolean;
  readonly expectedReusableCharacters: number;
  readonly model: string;
};

const TTL_MS: Readonly<Record<CacheTtl, number>> = { none: 0, "5m": 300_000, "1h": 3_600_000 };

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function blockStats(block: PromptBlock): BlockStats {
  return {
    digest: sha256(JSON.stringify(block)),
    textCharacters: block.text.length,
    imageCharacters: block.images.reduce((total, image) => total + image.data.length, 0),
    wireBlocks: 1 + block.images.length,
  };
}

function fingerprint(blocks: readonly BlockStats[]): string {
  return sha256(blocks.map((block) => block.digest).join("\n")).slice(0, 16);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function classify(
  previous: RequestState | undefined,
  current: RequestState,
  divergence: number,
): PrefixChange {
  if (previous === undefined) {
    return "first";
  }
  if (previous.model !== current.model) {
    return "model-changed";
  }
  if (previous.reasoning !== current.reasoning) {
    return "reasoning-changed";
  }
  if (previous.toolsFingerprint !== current.toolsFingerprint) {
    return "tools-changed";
  }
  if (divergence === 0) {
    return "system-changed";
  }
  const previousClosingBlock = previous.blocks.length - 1;
  return divergence === -1 || divergence >= previousClosingBlock ? "appended" : "history-rewritten";
}

function reachesPreviousWrite(previous: RequestState, current: RequestState, common: number) {
  return previous.breakpoints
    .filter((written) => written < common)
    .some((written) =>
      current.breakpoints.some(
        (breakpoint) =>
          breakpoint >= written &&
          sum(current.blocks.slice(written + 1, breakpoint + 1).map((block) => block.wireBlocks)) <=
            CACHE_LOOKBACK_BLOCKS,
      ),
    );
}

function likelyMissCause(
  context: MissContext,
  usage: TokenUsage,
  promptTokens: number,
  minimumCacheableTokens: number | undefined,
): MissCause | undefined {
  if (context.ttl === "none") {
    return "caching-disabled";
  }
  if (
    minimumCacheableTokens !== undefined &&
    promptTokens > 0 &&
    promptTokens < minimumCacheableTokens &&
    usage.cacheRead === 0 &&
    usage.cacheWrite === 0
  ) {
    return "below-minimum";
  }
  if (context.prefixChange === "first") {
    return "first";
  }
  if ((context.msSincePreviousRequest ?? 0) > TTL_MS[context.ttl]) {
    return "ttl-expired";
  }
  if (context.prefixChange !== "appended") {
    return "prefix-changed";
  }
  return context.lookbackExceeded ? "lookback" : undefined;
}

function usageDiagnostic(
  turn: number,
  usage: TokenUsage,
  context: MissContext,
  metadata: CacheUsageMetadata = {},
): CacheUsageDiagnostic {
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  const minimumCacheableTokens = minimumCacheableTokensFor(metadata.observedModel ?? context.model);
  const cacheReadShare = promptTokens === 0 ? 0 : usage.cacheRead / promptTokens;
  const cause =
    cacheReadShare < 0.5
      ? likelyMissCause(context, usage, promptTokens, minimumCacheableTokens)
      : undefined;
  return {
    type: "usage",
    turn,
    ...usage,
    ...(metadata.query === undefined ? {} : { query: metadata.query }),
    promptTokens,
    ...(minimumCacheableTokens === undefined ? {} : { minimumCacheableTokens }),
    cacheReadPercent: Math.round(cacheReadShare * 10_000) / 100,
    possibleCollapse: promptTokens >= 20_000 && cacheReadShare < 0.5,
    expectedReusableCharacters: context.expectedReusableCharacters,
    ...(cause === undefined ? {} : { likelyMissCause: cause }),
  };
}

export const createCacheDiagnosticTracker = Effect.fnUntraced(function* (
  sink: (diagnostic: CacheDiagnostic) => void,
): Effect.fn.Return<CacheDiagnosticTracker> {
  const clock = yield* Clock.Clock;
  return trackWith(sink, () => clock.currentTimeMillisUnsafe());
});

function trackWith(
  sink: (diagnostic: CacheDiagnostic) => void,
  now: () => number,
): CacheDiagnosticTracker {
  let turn = 0;
  let previous: RequestState | undefined;
  const emit = (diagnostic: CacheDiagnostic): void => {
    try {
      sink(diagnostic);
    } catch {
      return undefined;
    }
  };

  return (model, request, settings = {}) => {
    turn += 1;
    const requestTurn = turn;
    const ttl = settings.ttl ?? "5m";
    const minimumCacheableTokens = minimumCacheableTokensFor(model);
    const current: RequestState = {
      model,
      reasoning: settings.reasoning,
      toolsFingerprint:
        request.toolDescription === undefined
          ? undefined
          : sha256(request.toolDescription).slice(0, 16),
      blocks: request.promptBlocks.map((block) => blockStats(block)),
      breakpoints: [...request.cacheBreakpoints],
      at: now(),
    };
    const { blocks, breakpoints } = current;
    const divergence = blocks.findIndex(
      (block, index) => block.digest !== previous?.blocks[index]?.digest,
    );
    const commonPrefix = blocks.slice(0, divergence === -1 ? blocks.length : divergence);
    const commonPrefixCharacters = sum(
      commonPrefix.map((block) => block.textCharacters + block.imageCharacters),
    );
    const prefixChange = classify(previous, current, divergence);
    const msSincePreviousRequest = previous === undefined ? undefined : current.at - previous.at;
    const lastBreakpoint = breakpoints.at(-1);
    emit({
      type: "request",
      turn,
      model,
      ...(minimumCacheableTokens === undefined ? {} : { minimumCacheableTokens }),
      ...(settings.reasoning === undefined ? {} : { reasoning: settings.reasoning }),
      ttl,
      blocks: blocks.length,
      textCharacters: sum(blocks.map((block) => block.textCharacters)),
      imageBase64Characters: sum(blocks.map((block) => block.imageCharacters)),
      breakpoints,
      commonPrefixBlocks: commonPrefix.length,
      commonPrefixCharacters,
      contentFingerprint: fingerprint(blocks),
      systemFingerprint: fingerprint(blocks.slice(0, 1)),
      ...(current.toolsFingerprint === undefined
        ? {}
        : { toolsFingerprint: current.toolsFingerprint }),
      ...(lastBreakpoint === undefined
        ? {}
        : { reusablePrefixFingerprint: fingerprint(blocks.slice(0, lastBreakpoint + 1)) }),
      prefixChange,
      ...(msSincePreviousRequest === undefined ? {} : { msSincePreviousRequest }),
    });
    const context: MissContext = {
      model,
      ttl,
      prefixChange,
      msSincePreviousRequest,
      lookbackExceeded:
        previous !== undefined &&
        previous.breakpoints.length > 0 &&
        !reachesPreviousWrite(previous, current, commonPrefix.length),
      expectedReusableCharacters: commonPrefixCharacters,
    };
    previous = current;
    return (usage, metadata) => {
      if (usage !== undefined) {
        emit(usageDiagnostic(requestTurn, usage, context, metadata));
      } else if (metadata?.query !== undefined) {
        emit({ type: "query", turn: requestTurn, query: metadata.query });
      }
    };
  };
}
