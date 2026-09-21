import { createHash } from "node:crypto";
import type { AgentRequest, PromptBlock } from "./agent-request";
import type { TokenUsage } from "./bridge";

/** Safe request metadata emitted by cache diagnostics. */
export interface CacheRequestDiagnostic {
  readonly type: "request";
  readonly turn: number;
  readonly model: string;
  readonly blocks: number;
  readonly textCharacters: number;
  readonly imageBase64Characters: number;
  readonly breakpointBlock?: number;
  readonly commonPrefixBlocks: number;
  readonly commonPrefixCharacters: number;
  readonly contentFingerprint: string;
  readonly reusablePrefixFingerprint?: string;
  readonly msSincePreviousRequest?: number;
}

/** Safe usage metadata emitted by cache diagnostics. */
export interface CacheUsageDiagnostic extends TokenUsage {
  readonly type: "usage";
  readonly turn: number;
  readonly promptTokens: number;
  readonly cacheReadPercent: number;
  readonly possibleCollapse: boolean;
}

/** Safe cache diagnostic record. */
export type CacheDiagnostic = CacheRequestDiagnostic | CacheUsageDiagnostic;

/** Records one outgoing prompt and returns the recorder for that turn's final usage. */
export type CacheDiagnosticTracker = (
  model: string,
  request: Pick<AgentRequest, "promptBlocks" | "cacheBreakpoint">,
) => (usage: TokenUsage) => void;

interface BlockStats {
  readonly payload: string;
  readonly textCharacters: number;
  readonly imageCharacters: number;
}

function blockStats(block: PromptBlock): BlockStats {
  return {
    payload: JSON.stringify(block),
    textCharacters: block.text.length,
    imageCharacters: block.images.reduce((total, image) => total + image.data.length, 0),
  };
}

function fingerprint(blocks: ReadonlyArray<BlockStats>): string {
  const payloads = blocks.map((block) => block.payload).join("\n");
  return createHash("sha256").update(payloads).digest("hex").slice(0, 16);
}

function sum(values: ReadonlyArray<number>): number {
  return values.reduce((total, value) => total + value, 0);
}

function usageDiagnostic(turn: number, usage: TokenUsage): CacheUsageDiagnostic {
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  const cacheReadShare = promptTokens === 0 ? 0 : usage.cacheRead / promptTokens;
  return {
    type: "usage",
    turn,
    ...usage,
    promptTokens,
    cacheReadPercent: Math.round(cacheReadShare * 10_000) / 100,
    possibleCollapse: promptTokens >= 20_000 && cacheReadShare < 0.5,
  };
}

/**
 * Create a tracker that compares consecutive prompt prefixes without logging content.
 *
 * @param sink - Destination for safe cache diagnostic records.
 * @param now - Clock used to measure the gap between requests.
 * @returns The stateful tracker.
 */
export function createCacheDiagnosticTracker(
  sink: (diagnostic: CacheDiagnostic) => void,
  now: () => number = Date.now,
): CacheDiagnosticTracker {
  let turn = 0;
  let previous: { readonly blocks: ReadonlyArray<BlockStats>; readonly at: number } | undefined;

  return (model, { promptBlocks, cacheBreakpoint }) => {
    turn += 1;
    const requestTurn = turn;
    const at = now();
    const blocks = promptBlocks.map(blockStats);
    const divergence = blocks.findIndex(
      (block, index) => block.payload !== previous?.blocks[index]?.payload,
    );
    const commonPrefix = blocks.slice(0, divergence === -1 ? blocks.length : divergence);
    sink({
      type: "request",
      turn,
      model,
      blocks: blocks.length,
      textCharacters: sum(blocks.map((block) => block.textCharacters)),
      imageBase64Characters: sum(blocks.map((block) => block.imageCharacters)),
      ...(cacheBreakpoint === undefined ? {} : { breakpointBlock: cacheBreakpoint }),
      commonPrefixBlocks: commonPrefix.length,
      commonPrefixCharacters: sum(
        commonPrefix.map((block) => block.textCharacters + block.imageCharacters),
      ),
      contentFingerprint: fingerprint(blocks),
      ...(cacheBreakpoint === undefined
        ? {}
        : { reusablePrefixFingerprint: fingerprint(blocks.slice(0, cacheBreakpoint + 1)) }),
      ...(previous ? { msSincePreviousRequest: at - previous.at } : {}),
    });
    previous = { blocks, at };
    return (usage) => sink(usageDiagnostic(requestTurn, usage));
  };
}
