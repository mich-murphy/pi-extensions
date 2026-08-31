import { createHash } from "node:crypto";
import type { PromptBlock } from "./agent-request";

/** Safe request metadata emitted by cache diagnostics. */
export interface CacheRequestDiagnostic {
  readonly type: "request";
  readonly turn: number;
  readonly model: string;
  readonly blocks: number;
  readonly textCharacters: number;
  readonly imageBase64Characters: number;
  readonly breakpointBlocks: ReadonlyArray<number>;
  readonly commonPrefixBlocks: number;
  readonly commonPrefixCharacters: number;
  readonly contentFingerprint: string;
  readonly reusablePrefixFingerprint?: string;
  readonly msSincePreviousRequest?: number;
}

/** Safe usage metadata emitted by cache diagnostics. */
export interface CacheUsageDiagnostic {
  readonly type: "usage";
  readonly turn: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly promptTokens: number;
  readonly cacheReadPercent: number;
  readonly possibleCollapse: boolean;
}

/** Safe cache diagnostic record. */
export type CacheDiagnostic = CacheRequestDiagnostic | CacheUsageDiagnostic;

/** Destination for safe cache diagnostic records. */
export type CacheDiagnosticSink = (diagnostic: CacheDiagnostic) => void;

/** Stateful cache diagnostic tracker. */
export interface CacheDiagnosticTracker {
  /** Record one outgoing prompt and return its turn number. */
  request(model: string, blocks: ReadonlyArray<PromptBlock>): number;
  /** Record usage for a prior request turn. */
  usage(
    turn: number,
    usage: {
      readonly input: number;
      readonly output: number;
      readonly cacheRead: number;
      readonly cacheWrite: number;
    },
  ): void;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function blockPayload(block: PromptBlock): string {
  return JSON.stringify({
    text: block.text,
    images: block.images?.map((image) => ({ mediaType: image.mediaType, data: image.data })) ?? [],
  });
}

function blockCharacters(block: PromptBlock): number {
  return (
    block.text.length + (block.images ?? []).reduce((total, image) => total + image.data.length, 0)
  );
}

function commonPrefixLength(
  previous: ReadonlyArray<string>,
  current: ReadonlyArray<string>,
): number {
  let index = 0;
  while (index < previous.length && index < current.length && previous[index] === current[index]) {
    index += 1;
  }
  return index;
}

function finalBreakpoint(blocks: ReadonlyArray<PromptBlock>): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]?.cacheBreakpoint === true) return index;
  }
  return -1;
}

function usageDiagnostic(
  turn: number,
  usage: Parameters<CacheDiagnosticTracker["usage"]>[1],
): CacheUsageDiagnostic {
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  const cacheReadPercent =
    promptTokens === 0 ? 0 : Math.round((usage.cacheRead / promptTokens) * 10_000) / 100;
  return {
    type: "usage",
    turn,
    ...usage,
    promptTokens,
    cacheReadPercent,
    possibleCollapse: promptTokens >= 20_000 && usage.cacheRead / promptTokens < 0.5,
  };
}

class CacheTracker implements CacheDiagnosticTracker {
  private turn = 0;
  private previousPayloads: ReadonlyArray<string> = [];
  private previousRequestAt: number | undefined;

  constructor(
    private readonly sink: CacheDiagnosticSink,
    private readonly now: () => number,
  ) {}

  request(model: string, blocks: ReadonlyArray<PromptBlock>): number {
    this.turn += 1;
    const requestedAt = this.now();
    const elapsed =
      this.previousRequestAt === undefined ? undefined : requestedAt - this.previousRequestAt;
    this.previousRequestAt = requestedAt;
    const payloads = blocks.map(blockPayload);
    const prefixLength = commonPrefixLength(this.previousPayloads, payloads);
    const breakpoint = finalBreakpoint(blocks);
    this.sink({
      type: "request",
      turn: this.turn,
      model,
      blocks: blocks.length,
      textCharacters: blocks.reduce((total, block) => total + block.text.length, 0),
      imageBase64Characters: blocks.reduce(
        (total, block) =>
          total + (block.images ?? []).reduce((sum, image) => sum + image.data.length, 0),
        0,
      ),
      breakpointBlocks: blocks.flatMap((block, index) => (block.cacheBreakpoint ? [index] : [])),
      commonPrefixBlocks: prefixLength,
      commonPrefixCharacters: blocks
        .slice(0, prefixLength)
        .reduce((total, block) => total + blockCharacters(block), 0),
      contentFingerprint: hash(payloads.join("\n")),
      ...(breakpoint >= 0
        ? { reusablePrefixFingerprint: hash(payloads.slice(0, breakpoint + 1).join("\n")) }
        : {}),
      ...(elapsed === undefined ? {} : { msSincePreviousRequest: elapsed }),
    });
    this.previousPayloads = payloads;
    return this.turn;
  }

  usage(turn: number, usage: Parameters<CacheDiagnosticTracker["usage"]>[1]): void {
    this.sink(usageDiagnostic(turn, usage));
  }
}

/** Create a tracker that compares consecutive prompt prefixes without logging content. */
export function createCacheDiagnosticTracker(
  sink: CacheDiagnosticSink,
  now: () => number = Date.now,
): CacheDiagnosticTracker {
  return new CacheTracker(sink, now);
}
