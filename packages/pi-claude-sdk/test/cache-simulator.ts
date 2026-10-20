import { createHash } from "node:crypto";
import { CACHE_LOOKBACK_BLOCKS, MAX_CACHE_BREAKPOINTS } from "../agent-request";
import type { AgentRequest } from "../agent-request";
import { buildPromptStream } from "../sdk/prompt-stream";
import type { CacheTtl } from "../sdk/prompt-stream";
import { drain, sdkContentRecords } from "./fixtures";

/** Tokens one image costs, approximated as a constant. */
const IMAGE_TOKENS = 1500;

/** Shortest prefix Anthropic stores; a shorter breakpoint writes nothing. */
const MINIMUM_CACHEABLE_TOKENS = 1024;

const FIVE_MINUTES_MS = 5 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;

/** Prompt tokens of one simulated request, split the way Anthropic bills them. */
export type CacheUsage = {
  /** Tokens read from an earlier cache entry. */
  readonly read: number;
  /** Tokens written to new cache entries. */
  readonly write: number;
  /** Tokens after the furthest breakpoint, or in a prefix too short to cache. */
  readonly uncached: number;
};

/** One wire content block, keyed by a hash of the whole prefix that ends with it. */
type WireBlock = {
  readonly index: number;
  readonly key: string;
  /** Prefix tokens up to and including this block. */
  readonly end: number;
  /** Cache lifetime when the block carries `cache_control`. */
  readonly ttlMs: number | undefined;
};

type Breakpoint = WireBlock & { readonly ttlMs: number };

type CacheEntry = { readonly expiresAt: number; readonly ttlMs: number };

type CacheStore = Map<string, CacheEntry>;

/**
 * Approximate the tokens of a text block.
 *
 * @param text - Block text.
 * @returns Roughly one token per four characters.
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function contentTokens(block: Readonly<Record<string, unknown>>): number {
  if (block.type === "image") {
    return IMAGE_TOKENS;
  }
  return typeof block.text === "string" ? estimateTextTokens(block.text) : 0;
}

function breakpointTtlMs(cacheControl: unknown): number | undefined {
  if (typeof cacheControl !== "object" || cacheControl === null) {
    return undefined;
  }
  return "ttl" in cacheControl && cacheControl.ttl === "1h" ? ONE_HOUR_MS : FIVE_MINUTES_MS;
}

/** Tools, then system, then the SDK user message content exactly as the prompt stream sends it. */
async function wireBlocks(request: AgentRequest, ttl: CacheTtl): Promise<WireBlock[]> {
  const [message] = await drain(
    buildPromptStream(request.promptBlocks, request.cacheBreakpoints, ttl),
  );
  const content: Record<string, unknown>[] = [
    { type: "tools", text: request.toolDescription },
    { type: "system", text: request.systemPrompt },
    ...sdkContentRecords(message),
  ];
  const blocks: WireBlock[] = [];
  let key = "";
  let end = 0;
  for (const { cache_control: cacheControl, ...block } of content) {
    key = createHash("sha256").update(key).update(JSON.stringify(block)).digest("hex");
    end += contentTokens(block);
    blocks.push({ index: blocks.length, key, end, ttlMs: breakpointTtlMs(cacheControl) });
  }
  return blocks;
}

function liveEntry(store: CacheStore, key: string, now: number): CacheEntry | undefined {
  const entry = store.get(key);
  return entry !== undefined && entry.expiresAt > now ? entry : undefined;
}

/** The longest live prefix within the lookback window ending at a breakpoint, itself included. */
function longestHit(
  store: CacheStore,
  blocks: readonly WireBlock[],
  breakpoint: Breakpoint,
  now: number,
) {
  const earliest = Math.max(0, breakpoint.index - CACHE_LOOKBACK_BLOCKS + 1);
  for (const block of blocks.slice(earliest, breakpoint.index + 1).toReversed()) {
    const entry = liveEntry(store, block.key, now);
    if (entry !== undefined) {
      return { block, entry };
    }
  }
  return undefined;
}

/** Read the longest hit over every breakpoint, refreshing the lifetime of each entry hit. */
function readCached(
  store: CacheStore,
  blocks: readonly WireBlock[],
  breakpoints: readonly Breakpoint[],
  now: number,
): number {
  let read = 0;
  for (const breakpoint of breakpoints) {
    const hit = longestHit(store, blocks, breakpoint, now);
    if (hit !== undefined) {
      store.set(hit.block.key, { ...hit.entry, expiresAt: now + hit.entry.ttlMs });
      read = Math.max(read, hit.block.end);
    }
  }
  return read;
}

/** Store every uncached breakpoint long enough to cache; returns the furthest prefix stored. */
function writeUncached(store: CacheStore, breakpoints: readonly Breakpoint[], now: number): number {
  let furthest = 0;
  for (const { key, end, ttlMs } of breakpoints) {
    if (end >= MINIMUM_CACHEABLE_TOKENS && liveEntry(store, key, now) === undefined) {
      store.set(key, { expiresAt: now + ttlMs, ttlMs });
      furthest = Math.max(furthest, end);
    }
  }
  return furthest;
}

/**
 * Build a deterministic model of Anthropic prompt caching shared by every request sent to it.
 *
 * Each breakpoint looks back over itself and the preceding blocks, up to the lookback window,
 * for the longest unexpired cached prefix; the request reads the best hit over all breakpoints
 * and writes everything from there to the furthest newly stored breakpoint.
 *
 * @param clock - Current time in milliseconds, read once per request.
 * @returns The simulator.
 */
export function createCacheSimulator(clock: () => number): {
  readonly send: (request: AgentRequest, ttl: CacheTtl) => Promise<CacheUsage>;
} {
  const store: CacheStore = new Map();
  return {
    send: async (request, ttl) => {
      const now = clock();
      const blocks = await wireBlocks(request, ttl);
      const breakpoints = blocks.filter((block): block is Breakpoint => block.ttlMs !== undefined);
      if (breakpoints.length > MAX_CACHE_BREAKPOINTS) {
        throw new RangeError(`Anthropic rejects ${breakpoints.length} cache breakpoints`);
      }
      const read = readCached(store, blocks, breakpoints, now);
      const write = Math.max(0, writeUncached(store, breakpoints, now) - read);
      const total = blocks.at(-1)?.end ?? 0;
      return { read, write, uncached: total - read - write };
    },
  };
}

/**
 * Share of a request's prompt tokens read from cache.
 *
 * @param usage - Simulated usage of one or more requests.
 * @returns read / (read + write + uncached), or 0 for an empty prompt.
 */
export function readShare({ read, write, uncached }: CacheUsage): number {
  const total = read + write + uncached;
  return total === 0 ? 0 : read / total;
}
