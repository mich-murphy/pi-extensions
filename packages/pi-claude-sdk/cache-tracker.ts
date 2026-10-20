import { createHash } from "node:crypto";
import { Clock, Effect } from "effect";
import { CACHE_LOOKBACK_BLOCKS } from "./agent-request";
import type { AgentRequest, PromptBlock } from "./agent-request";
import type { TokenUsage } from "./bridge";
import type { CacheTtl } from "./sdk/prompt-stream";

/** Safe request metadata emitted by cache diagnostics. */
export type CacheRequestDiagnostic = {
  readonly type: "request";
  readonly turn: number;
  readonly model: string;
  readonly reasoning?: string;
  readonly ttl: CacheTtl;
  readonly blocks: number;
  readonly textCharacters: number;
  readonly imageBase64Characters: number;
  readonly breakpoints: readonly number[];
  readonly commonPrefixBlocks: number;
  readonly commonPrefixCharacters: number;
  readonly contentFingerprint: string;
  /** Fingerprint of the preamble block carrying the Pi working instructions. */
  readonly systemFingerprint: string;
  /** Fingerprint of the gateway tool catalog, when the request carries one. */
  readonly toolsFingerprint?: string;
  readonly reusablePrefixFingerprint?: string;
  /** How this prompt differs from the previous request's. */
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

/** Safe usage metadata emitted by cache diagnostics. */
export type CacheUsageDiagnostic = {
  readonly type: "usage";
  readonly turn: number;
  readonly promptTokens: number;
  readonly cacheReadPercent: number;
  readonly possibleCollapse: boolean;
  /** Characters shared with the previous request's prompt, which cache could have served. */
  readonly expectedReusableCharacters: number;
  /** Most probable reason for a cache read share below 50%. */
  readonly likelyMissCause?:
    | "caching-disabled"
    | "below-minimum"
    | "first"
    | "ttl-expired"
    | "prefix-changed"
    | "lookback";
} & TokenUsage;

/** Safe cache diagnostic record. */
export type CacheDiagnostic = CacheRequestDiagnostic | CacheUsageDiagnostic;

/** Records one outgoing prompt and returns the recorder for that turn's final usage. */
export type CacheDiagnosticTracker = (
  model: string,
  request: Pick<AgentRequest, "promptBlocks" | "cacheBreakpoints"> & {
    readonly toolDescription?: string;
  },
  settings?: { readonly ttl?: CacheTtl; readonly reasoning?: string | undefined },
) => (usage: TokenUsage) => void;

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
};

const TTL_MS: Readonly<Record<CacheTtl, number>> = { none: 0, "5m": 300_000, "1h": 3_600_000 };

/** Smallest prefix Anthropic caches for most models. */
const MINIMUM_CACHEABLE_TOKENS = 1024;

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
  // The previous closing block is not history, so diverging there only appends entries.
  return divergence === -1 || divergence >= previous.blocks.length - 1
    ? "appended"
    : "history-rewritten";
}

/** Whether some current breakpoint finds an entry the previous request wrote within the lookback. */
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

function likelyMissCause(context: MissContext, promptTokens: number): MissCause | undefined {
  if (context.ttl === "none") {
    return "caching-disabled";
  }
  if (promptTokens < MINIMUM_CACHEABLE_TOKENS) {
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
): CacheUsageDiagnostic {
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  const cacheReadShare = promptTokens === 0 ? 0 : usage.cacheRead / promptTokens;
  const cause = cacheReadShare < 0.5 ? likelyMissCause(context, promptTokens) : undefined;
  return {
    type: "usage",
    turn,
    ...usage,
    promptTokens,
    cacheReadPercent: Math.round(cacheReadShare * 10_000) / 100,
    possibleCollapse: promptTokens >= 20_000 && cacheReadShare < 0.5,
    expectedReusableCharacters: context.expectedReusableCharacters,
    ...(cause === undefined ? {} : { likelyMissCause: cause }),
  };
}

/**
 * Create a tracker that compares consecutive prompt prefixes without logging content.
 *
 * The tracker stays a synchronous closure because the runner calling it is not yet an Effect;
 * it reads time from the `Clock` in scope when it is created, so a test clock controls it.
 *
 * @param sink - Destination for safe cache diagnostic records.
 * @returns The stateful tracker.
 */
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

  return (model, request, settings = {}) => {
    turn += 1;
    const requestTurn = turn;
    const ttl = settings.ttl ?? "5m";
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
    sink({
      type: "request",
      turn,
      model,
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
    return (usage) => {
      sink(usageDiagnostic(requestTurn, usage, context));
    };
  };
}
