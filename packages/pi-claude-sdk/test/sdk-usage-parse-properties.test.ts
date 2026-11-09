import assert from "node:assert/strict";
import { Database, Hegel } from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { Effect } from "effect";
import { describe, test } from "vitest";
import { ClaudeUsageQueries, inspectClaudeUsage } from "../sdk-usage";
import type { ClaudeUsageStatus } from "../sdk-usage";

const settings = { testCases: 200, seed: 12_345n, database: Database.disabled };
const FIXED = [
  ["five_hour", "Current session"],
  ["seven_day", "All models weekly"],
  ["seven_day_oauth_apps", "OAuth apps weekly"],
  ["seven_day_opus", "Opus weekly"],
  ["seven_day_sonnet", "Sonnet weekly"],
] as const;
const SCOPED_NAMES = ["Opus", "opus", "OPUS", "Fable", "fable", "Sonnet", "x", "Current session"];

type Window = { utilization: number | null; resets_at: string | null };
type Candidate = { name: string; usedPercent: number | null };
type Outcome = { status: ClaudeUsageStatus } | { failed: string };

async function inspect(rateLimits: unknown): Promise<Outcome> {
  const response = {
    subscription_type: null,
    rate_limits_available: true,
    rate_limits: rateLimits,
  };
  const layer = ClaudeUsageQueries.fromStart(() => ({
    readUsage: async () => response,
    close: async () => undefined,
  }));
  return Effect.runPromise(
    inspectClaudeUsage().pipe(
      Effect.provide(layer),
      Effect.match({
        onSuccess: (status): Outcome => ({ status }),
        onFailure: (error): Outcome => ({ failed: String(Reflect.get(error, "operation")) }),
      }),
    ),
  );
}

function drawWindow(tc: TestCase): Window | null | undefined {
  const kind = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));
  if (kind === 0) {
    return undefined;
  }
  if (kind === 1) {
    return null;
  }
  const utilization = tc.draw(gs.optional(gs.integers({ minValue: 0, maxValue: 100 })));
  return { utilization, resets_at: null };
}

async function assertDedupe(tc: TestCase): Promise<void> {
  const rateLimits: Record<string, unknown> = {};
  const candidates: Candidate[] = [];
  for (const [key, name] of FIXED) {
    const window = drawWindow(tc);
    if (window !== undefined) {
      rateLimits[key] = window;
    }
    if (window) {
      candidates.push({ name, usedPercent: window.utilization });
    }
  }
  const scoped = tc.draw(
    gs.arrays(
      gs.tuples(
        gs.sampledFrom(SCOPED_NAMES),
        gs.optional(gs.integers({ minValue: 0, maxValue: 100 })),
      ),
      { maxSize: 6 },
    ),
  );
  rateLimits.model_scoped = scoped.map(([display_name, utilization]) => ({
    display_name,
    utilization,
    resets_at: null,
  }));
  for (const [display, usedPercent] of scoped) {
    candidates.push({ name: `${display} weekly`, usedPercent });
  }
  const outcome = await inspect(rateLimits);
  assert.ok("status" in outcome);
  const keys = outcome.status.windows.map((w) => w.name.toLowerCase());
  assert.equal(new Set(keys).size, keys.length);
  const expectedKeys = new Set(candidates.map((c) => c.name.toLowerCase()));
  assert.deepEqual(new Set(keys), expectedKeys);
  let previous = -1;
  for (const window of outcome.status.windows) {
    const first = candidates.findIndex((c) => c.name.toLowerCase() === window.name.toLowerCase());
    assert.equal(candidates[first]?.name, window.name);
    assert.equal(candidates[first]?.usedPercent, window.usedPercent);
    assert.ok(first > previous);
    previous = first;
  }
}

async function assertUtilizationBounds(tc: TestCase): Promise<void> {
  const bad = tc.draw(
    gs.oneOf(
      gs.floats({ minValue: 100.001, maxValue: 1e9 }),
      gs.floats({ minValue: -1e9, maxValue: -0.001 }),
    ),
  );
  const where = tc.draw(gs.sampledFrom(["five_hour", "seven_day_opus", "model_scoped"]));
  const good = tc.draw(gs.integers({ minValue: 0, maxValue: 100 }));
  const window = { utilization: bad, resets_at: null };
  const goodWindow = { utilization: good, resets_at: null };
  const limits =
    where === "model_scoped"
      ? {
          model_scoped: [
            { ...goodWindow, display_name: "ok" },
            { ...window, display_name: "m" },
          ],
        }
      : { seven_day: goodWindow, [where]: window };
  assert.deepEqual(await inspect(limits), { failed: "parse" });
  const edge = tc.draw(gs.sampledFrom([0, 100]));
  const accepted = await inspect({ five_hour: { utilization: edge, resets_at: null } });
  assert.ok("status" in accepted);
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

async function assertResetDate(tc: TestCase): Promise<void> {
  const year = tc.draw(
    gs.oneOf(
      gs.integers({ minValue: 0, maxValue: 9999 }),
      gs.sampledFrom([1900, 2000, 2024, 2100, 2023, 1600, 2400, 0]),
    ),
  );
  const month = tc.draw(
    gs.oneOf(gs.integers({ minValue: 0, maxValue: 13 }), gs.sampledFrom([2, 2, 4, 12])),
  );
  const day = tc.draw(
    gs.oneOf(
      gs.integers({ minValue: 0, maxValue: 32 }),
      gs.integers({ minValue: 28, maxValue: 31 }),
    ),
  );
  const resets = `${pad(year, 4)}-${pad(month)}-${pad(day)}T12:00:00Z`;
  const outcome = await inspect({ five_hour: { utilization: null, resets_at: resets } });
  const valid = month >= 1 && month <= 12 && day >= 1 && isRealDate(year, month, day);
  assert.equal("status" in outcome, valid, resets);
}

describe("usage response parsing properties", () => {
  test("window names are unique case-insensitively, first wins, model-scoped last", async () => {
    await new Hegel(async (tc) => assertDedupe(tc))
      .databaseKey("pi-claude-sdk/usage-dedupe")
      .settings(settings)
      .run();
  });

  test("utilization outside 0..100 is a parse error", async () => {
    await new Hegel(async (tc) => assertUtilizationBounds(tc))
      .databaseKey("pi-claude-sdk/usage-bounds")
      .settings(settings)
      .run();
  });

  test("reset dates are accepted exactly when they are real calendar dates", async () => {
    await new Hegel(async (tc) => assertResetDate(tc))
      .databaseKey("pi-claude-sdk/usage-reset-date")
      .settings(settings)
      .run();
  });
});
