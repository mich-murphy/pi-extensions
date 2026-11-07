import { describe, expect, test } from "vitest";
import { runAll } from "./run.js";
import type { Metrics } from "./trial.js";

function pick(results: Metrics[], scenario: string, arm: string): Metrics {
  const found = results.find((r) => r.scenario === scenario && r.arm === arm);
  if (found === undefined) {
    throw new Error(`missing ${scenario}/${arm}`);
  }
  return found;
}

describe("offline codemode vs direct tools (simulated gateway, scripted recorder)", () => {
  test("both arms answer correctly with only permitted exact-revision reads", async () => {
    const results = await runAll(["single_read", "aggregate"], 1);
    expect(results).toHaveLength(4);
    expect(results.map((r) => r.correct)).toStrictEqual([true, true, true, true]);
    expect(results.map((r) => r.traceOk)).toStrictEqual([true, true, true, true]);
    expect(results.map((r) => `${r.scenario}:${r.gatewayOps}`).toSorted()).toStrictEqual([
      "aggregate:11",
      "aggregate:11",
      "single_read:1",
      "single_read:1",
    ]);
    const direct = pick(results, "aggregate", "direct");
    const codemode = pick(results, "aggregate", "codemode");
    expect(codemode.rounds).toBeLessThan(direct.rounds);
    expect(codemode.toolResultBytes).toBeLessThan(direct.toolResultBytes);
    expect(pick(results, "single_read", "codemode").cumulativeRequestBytes).toBeGreaterThan(
      pick(results, "single_read", "direct").cumulativeRequestBytes,
    );
  }, 120_000);
});
