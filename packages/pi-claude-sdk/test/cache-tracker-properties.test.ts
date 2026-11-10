import assert from "node:assert/strict";
import { stateful } from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { Clock, Effect } from "effect";
import { describe, test } from "vitest";
import {
  assertHegel,
  propertySettings,
  propertyTimeout,
} from "../../../test-support/hegel-settings";
import type { PromptBlock } from "../agent-request";
import type { TokenUsage } from "../bridge";
import { createCacheDiagnosticTracker } from "../cache-tracker";
import type {
  CacheDiagnostic,
  CacheDiagnosticTracker,
  CacheRequestDiagnostic,
  CacheUsageDiagnostic,
} from "../cache-tracker";

const settings = propertySettings(200);
const MODELS = ["claude-sdk/sonnet", "claude-sdk/claude-haiku-4-5", "other"] as const;
/** Documented minimums per model, written out independently of `models.ts` lookups. */
const MINIMUMS: Readonly<Record<string, number | undefined>> = {
  "claude-sdk/sonnet": 512,
  "claude-sdk/claude-haiku-4-5": 4096,
  other: undefined,
};
const TTL_MS = { none: 0, "5m": 300_000, "1h": 3_600_000 } as const;
type Ttl = keyof typeof TTL_MS;

type Req = {
  readonly model: string;
  readonly reasoning: string | undefined;
  readonly tools: string | undefined;
  readonly ttl: Ttl | undefined;
  readonly blocks: readonly PromptBlock[];
};
type Pending = {
  readonly turn: number;
  readonly model: string;
  readonly ttl: Ttl;
  readonly change: CacheRequestDiagnostic["prefixChange"];
  readonly gap: number | undefined;
};
type Machine = {
  readonly tracker: CacheDiagnosticTracker;
  readonly clock: ManualClock;
  readonly events: CacheDiagnostic[];
  previous: Req | undefined;
  previousAt: number;
  turn: number;
  now: number;
  readonly pending: Pending[];
};

/** The tracker only reads the time, so a clock the machine moves by hand is enough and stays synchronous. */
type ManualClock = { time: number };

function manualClockService(state: ManualClock): Clock.Clock {
  const nanos = () => BigInt(state.time) * 1_000_000n;
  return {
    currentTimeMillisUnsafe: () => state.time,
    currentTimeMillis: Effect.sync(() => state.time),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    sleep: () => Effect.void,
  };
}

function createMachine(): Machine {
  const events: CacheDiagnostic[] = [];
  const clock: ManualClock = { time: 0 };
  const tracker = Effect.runSync(
    createCacheDiagnosticTracker((event) => {
      events.push(event);
      // A failing destination must never propagate out of the tracker.
      throw new Error("sink failure");
    }).pipe(Effect.provideService(Clock.Clock, manualClockService(clock))),
  );
  return {
    tracker,
    clock,
    events,
    previous: undefined,
    previousAt: 0,
    turn: 0,
    now: 0,
    pending: [],
  };
}

function previousOf(machine: Machine): Req {
  assert.ok(machine.previous);
  return machine.previous;
}

function lastRequest(machine: Machine): CacheRequestDiagnostic {
  const event = machine.events.at(-1);
  assert.ok(event?.type === "request");
  return event;
}

function plainBlock(text: string): PromptBlock {
  return { text, images: [] };
}

function drawBlock(tc: TestCase): PromptBlock {
  const text = tc.draw(gs.arrays(gs.sampledFrom(["a", "b"]), { maxSize: 2 })).join("");
  const images = tc.draw(gs.arrays(gs.sampledFrom(["x", "yy"]), { maxSize: 1 }));
  return { text, images: images.map((data) => ({ data, mediaType: "image/png" })) };
}

function drawBlocks(tc: TestCase): PromptBlock[] {
  return tc.draw(gs.integers({ minValue: 0, maxValue: 4 })) === 0
    ? []
    : Array.from({ length: tc.draw(gs.integers({ minValue: 1, maxValue: 4 })) }, () =>
        drawBlock(tc),
      );
}

function drawSettings(tc: TestCase): Omit<Req, "blocks"> {
  return {
    model: tc.draw(gs.sampledFrom(MODELS)),
    reasoning: tc.draw(gs.sampledFrom([undefined, "low", "high"])),
    tools: tc.draw(gs.sampledFrom([undefined, "t1", "t2"])),
    ttl: tc.draw(gs.sampledFrom([undefined, "none", "5m", "1h"] as const)),
  };
}

function sameBlock(left: PromptBlock | undefined, right: PromptBlock | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.text === right.text &&
    left.images.length === right.images.length &&
    left.images.every((image, index) => image.data === right.images[index]?.data)
  );
}

/** Independent common prefix: direct block comparison, bounded by both lengths. */
function commonPrefix(previous: Req | undefined, blocks: readonly PromptBlock[]): number {
  let count = 0;
  while (count < blocks.length && sameBlock(blocks[count], previous?.blocks[count])) {
    count += 1;
  }
  return count;
}

function characters(blocks: readonly PromptBlock[], images: boolean): number {
  return blocks.reduce(
    (total, block) =>
      total +
      (images
        ? block.images.reduce((sum, image) => sum + image.data.length, 0)
        : block.text.length),
    0,
  );
}

function expectedChange(
  previous: Req | undefined,
  req: Req,
  common: number,
): CacheRequestDiagnostic["prefixChange"] {
  if (previous === undefined) {
    return "first";
  }
  if (previous.model !== req.model) {
    return "model-changed";
  }
  if (previous.reasoning !== req.reasoning) {
    return "reasoning-changed";
  }
  if (previous.tools !== req.tools) {
    return "tools-changed";
  }
  if (common === req.blocks.length) {
    return "appended";
  }
  if (common === 0) {
    return "system-changed";
  }
  return common >= previous.blocks.length - 1 ? "appended" : "history-rewritten";
}

function submit(machine: Machine, req: Req): void {
  const before = machine.events.length;
  const recorder = machine.tracker(
    req.model,
    {
      promptBlocks: req.blocks,
      cacheBreakpoints: [],
      ...(req.tools === undefined ? {} : { toolDescription: req.tools }),
    },
    { ...(req.ttl === undefined ? {} : { ttl: req.ttl }), reasoning: req.reasoning },
  );
  assert.equal(machine.events.length, before + 1);
  const event = machine.events.at(-1);
  assert.equal(event?.type, "request");
  assert.equal(event.type === "request" && event.turn, machine.turn + 1);
  machine.turn += 1;
  const request = event;
  const common = commonPrefix(machine.previous, req.blocks);
  const change = expectedChange(machine.previous, req, common);
  assert.equal(request.model, req.model);
  assert.equal(request.blocks, req.blocks.length);
  assert.ok(
    request.commonPrefixBlocks <= Math.min(req.blocks.length, machine.previous?.blocks.length ?? 0),
  );
  assert.equal(request.commonPrefixBlocks, common);
  assert.equal(request.textCharacters, characters(req.blocks, false));
  assert.equal(request.imageBase64Characters, characters(req.blocks, true));
  assert.equal(
    request.commonPrefixCharacters,
    characters(req.blocks.slice(0, common), false) + characters(req.blocks.slice(0, common), true),
  );
  assert.equal(request.prefixChange, change);
  assert.equal(request.minimumCacheableTokens, MINIMUMS[req.model]);
  const gap = machine.previous === undefined ? undefined : machine.now - machine.previousAt;
  assert.equal(request.msSincePreviousRequest, gap);
  machine.pending.push({
    turn: machine.turn,
    model: req.model,
    ttl: req.ttl ?? "5m",
    change,
    gap,
  });
  machine.previous = req;
  machine.previousAt = machine.now;
  recorders.set(machine.turn, recorder);
}

const recorders = new Map<number, ReturnType<CacheDiagnosticTracker>>();

/** Table oracle for the likely cause; undefined means "appended, fresh, nothing to blame". */
function expectedCauses(
  pending: Pending,
  usage: TokenUsage,
  prompt: number,
): readonly (string | undefined)[] {
  if (pending.ttl === "none") {
    return ["caching-disabled"];
  }
  if (belowMinimum(pending, usage, prompt)) {
    return ["below-minimum"];
  }
  if (pending.change === "first") {
    return ["first"];
  }
  if ((pending.gap ?? 0) > TTL_MS[pending.ttl]) {
    return ["ttl-expired"];
  }
  return pending.change === "appended" ? ["lookback", undefined] : ["prefix-changed"];
}

function belowMinimum(pending: Pending, usage: TokenUsage, prompt: number): boolean {
  const minimum = MINIMUMS[pending.model];
  const cold = usage.cacheRead === 0 && usage.cacheWrite === 0;
  return minimum !== undefined && prompt > 0 && prompt < minimum && cold;
}

function checkUsage(usage: TokenUsage, pending: Pending, event: CacheUsageDiagnostic): void {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  assert.equal(event.turn, pending.turn);
  assert.equal(event.promptTokens, prompt);
  assert.ok(event.cacheReadPercent >= 0 && event.cacheReadPercent <= 100);
  assert.equal(event.minimumCacheableTokens, MINIMUMS[pending.model]);
  // Zero prompt tokens means share 0, which counts as a low read.
  const low = prompt === 0 || usage.cacheRead * 2 < prompt;
  if (prompt === 0) {
    assert.equal(event.cacheReadPercent, 0);
  }
  assert.equal(event.possibleCollapse, prompt >= 20_000 && low);
  if (low) {
    assert.ok(expectedCauses(pending, usage, prompt).includes(event.likelyMissCause));
  } else {
    assert.equal(event.likelyMissCause, undefined);
  }
}

function report(machine: Machine, index: number, usage: TokenUsage): void {
  const [pending] = machine.pending.splice(index, 1);
  assert.ok(pending);
  const before = machine.events.length;
  recorders.get(pending.turn)?.(usage);
  assert.equal(machine.events.length, before + 1);
  const event = machine.events.at(-1);
  assert.equal(event?.type, "usage");
  checkUsage(usage, pending, event);
}

function drawTokens(tc: TestCase, name: string): number {
  return tc.draw(
    gs.oneOf(
      gs.just(0),
      // Boundary values around the possibleCollapse threshold of 20k prompt tokens.
      gs.sampledFrom([19_999, 20_000, 20_001, 10_000, 5000]),
      gs.integers({ minValue: 0, maxValue: 1000 }),
      gs.integers({ minValue: 0, maxValue: 2_000_000 }),
    ),
    name,
  );
}

/**
 * Rules never reject. Hegel enables a random subset of rules per case, and a rule gated by `assume`
 * on earlier state was rejected about 96% of the time, so most of the time went to rejected steps. A rule
 * that needs a request or a pending usage report makes one first, which keeps every state reachable.
 */
function drawRequest(tc: TestCase): Req {
  return { ...drawSettings(tc), blocks: drawBlocks(tc) };
}

function ensureRequest(tc: TestCase, machine: Machine): Req {
  if (machine.previous === undefined) {
    submit(machine, drawRequest(tc));
  }
  return previousOf(machine);
}

function rewriteBlocks(tc: TestCase, previous: Req): readonly PromptBlock[] {
  if (previous.blocks.length === 0) {
    return [drawBlock(tc)];
  }
  const at = tc.draw(gs.integers({ minValue: 0, maxValue: previous.blocks.length - 1 }));
  return previous.blocks.map((block, index) => (index === at ? drawBlock(tc) : block));
}

const machineSpec: stateful.StateMachine<Machine> = {
  rules: {
    fresh: (tc, machine) => {
      submit(machine, drawRequest(tc));
    },
    identical: (tc, machine) => {
      submit(machine, ensureRequest(tc, machine));
      const request = lastRequest(machine);
      assert.equal(request.prefixChange, "appended");
      assert.equal(request.commonPrefixBlocks, request.blocks);
    },
    extend: (tc, machine) => {
      const previous = ensureRequest(tc, machine);
      submit(machine, { ...previous, blocks: [...previous.blocks, drawBlock(tc)] });
    },
    rewrite: (tc, machine) => {
      const previous = ensureRequest(tc, machine);
      submit(machine, { ...previous, blocks: rewriteBlocks(tc, previous) });
    },
    retune: (tc, machine) => {
      submit(machine, { ...ensureRequest(tc, machine), ...drawSettings(tc) });
    },
    tick: (tc, machine) => {
      const ms = tc.draw(gs.sampledFrom([0, 1000, 300_000, 300_001, 3_600_000, 3_600_001]));
      machine.clock.time += ms;
      machine.now += ms;
    },
    report: (tc, machine) => {
      if (machine.pending.length === 0) {
        submit(machine, drawRequest(tc));
      }
      // Any pending recorder, in any order: each keeps its own turn and model.
      const index = tc.draw(gs.integers({ minValue: 0, maxValue: machine.pending.length - 1 }));
      // Half the reports sit exactly around the 20k collapse threshold (all tokens uncached).
      const boundary = tc.draw(gs.booleans(), "boundary");
      report(
        machine,
        index,
        boundary
          ? {
              input: tc.draw(gs.sampledFrom([19_999, 20_000, 20_001]), "input"),
              output: drawTokens(tc, "output"),
              cacheRead: 0,
              cacheWrite: 0,
            }
          : {
              input: drawTokens(tc, "input"),
              output: drawTokens(tc, "output"),
              cacheRead: drawTokens(tc, "cacheRead"),
              cacheWrite: drawTokens(tc, "cacheWrite"),
            },
      );
    },
  },
};

describe("cache tracker properties", () => {
  // About 0.8s alone and up to 5.0s with the CPU saturated: the timeout is ten times the latter and
  // grows with HEGEL_TEST_CASES.
  test(
    "request and usage diagnostics follow an independent model across any call sequence",
    () => {
      assertHegel(settings, (tc) => {
        recorders.clear();
        assert.equal(recorders.size, 0);
        stateful.run(tc, machineSpec, createMachine());
      });
    },
    propertyTimeout(60_000),
  );

  test("classification priority is model > reasoning > tools > divergence (example table)", () => {
    const base: Req = {
      model: "claude-sdk/sonnet",
      reasoning: undefined,
      tools: "t1",
      ttl: undefined,
      blocks: [plainBlock("a"), plainBlock("b")],
    };
    const changed = { model: "other", reasoning: "high", tools: "t2", blocks: [plainBlock("z")] };
    const table: readonly [Partial<Req>, CacheRequestDiagnostic["prefixChange"]][] = [
      [changed, "model-changed"],
      [{ reasoning: "high", tools: "t2", blocks: changed.blocks }, "reasoning-changed"],
      [{ tools: "t2", blocks: changed.blocks }, "tools-changed"],
      [{ blocks: changed.blocks }, "system-changed"],
    ];
    for (const [override, expected] of table) {
      const machine = createMachine();
      submit(machine, base);
      submit(machine, { ...base, ...override });
      assert.equal(lastRequest(machine).prefixChange, expected);
    }
  });
});
