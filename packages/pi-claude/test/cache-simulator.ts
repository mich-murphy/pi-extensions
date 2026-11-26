import { createHash } from "node:crypto";
import { CACHE_LOOKBACK_BLOCKS, MAX_CACHE_BREAKPOINTS } from "../agent-request";
import type { AgentRequest } from "../agent-request";
import { buildPromptStream } from "../sdk/prompt-stream";
import type { CacheTtl } from "../sdk/prompt-stream";
import { drain, sdkContentRecords } from "./fixtures";
import type { SdkPromptBlock } from "./fixtures";

const IMAGE_TOKENS = 1500;

const MINIMUM_CACHEABLE_TOKENS = 1024;

const FIVE_MINUTES_MS = 5 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;

export type CacheUsage = {
  readonly read: number;
  readonly write: number;
  readonly uncached: number;
};

type WireBlock = {
  readonly index: number;
  readonly key: string;
  readonly end: number;
  readonly ttlMs: number | undefined;
};

type Breakpoint = WireBlock & { readonly ttlMs: number };

type CacheEntry = { readonly expiresAt: number; readonly ttlMs: number };

type CacheStore = Map<string, CacheEntry>;

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

type CacheContentBlock =
  | SdkPromptBlock
  | { readonly type: "tools" | "system"; readonly text: string; readonly cache_control?: never };

function contentTokens(block: Omit<CacheContentBlock, "cache_control">): number {
  if (block.type === "image") {
    return IMAGE_TOKENS;
  }

  return block.text === undefined ? 0 : estimateTextTokens(block.text);
}

function breakpointTtlMs(cacheControl: SdkPromptBlock["cache_control"]): number | undefined {
  if (cacheControl === undefined) {
    return undefined;
  }

  return cacheControl.ttl === "1h" ? ONE_HOUR_MS : FIVE_MINUTES_MS;
}

async function wireBlocks(request: AgentRequest, ttl: CacheTtl): Promise<Array<WireBlock>> {
  const [message] = await drain(
    buildPromptStream(request.promptBlocks, request.cacheBreakpoints, ttl),
  );

  const content: Array<CacheContentBlock> = [
    { type: "tools", text: request.toolDescription },
    { type: "system", text: request.systemPrompt },
    ...sdkContentRecords(message),
  ];

  const blocks: Array<WireBlock> = [];
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

function longestHit(
  store: CacheStore,
  blocks: ReadonlyArray<WireBlock>,
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

function readCached(
  store: CacheStore,
  blocks: ReadonlyArray<WireBlock>,
  breakpoints: ReadonlyArray<Breakpoint>,
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

function writeUncached(
  store: CacheStore,
  breakpoints: ReadonlyArray<Breakpoint>,
  now: number,
): number {
  let furthest = 0;

  for (const { key, end, ttlMs } of breakpoints) {
    if (end >= MINIMUM_CACHEABLE_TOKENS && liveEntry(store, key, now) === undefined) {
      store.set(key, { expiresAt: now + ttlMs, ttlMs });
      furthest = Math.max(furthest, end);
    }
  }

  return furthest;
}

export type CacheSimulator = {
  readonly send: (request: AgentRequest, ttl: CacheTtl) => Promise<CacheUsage>;
};

export function createCacheSimulator(clock: () => number): CacheSimulator {
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

export function readShare({ read, write, uncached }: CacheUsage): number {
  const total = read + write + uncached;

  return total === 0 ? 0 : read / total;
}
