import assert from "node:assert/strict";
import { Hegel } from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { Effect } from "effect";
import { describe, test } from "vitest";
import { propertySettings } from "../../../test-support/hegel-settings";
import { ClaudeSdkVersionSources, inspectClaudeSdkVersions } from "../sdk-version-status";

const settings = propertySettings(200);
const NOISE: readonly ((version: string) => string)[] = [
  (version) => version,
  (version) => `${version} (Claude Code)`,
  (version) => `v${version}`,
  (version) => `claude ${version} stable\n`,
];

type Triple = readonly [number, number, number];
type Scenario = { readonly bundled: Triple; readonly installed: Triple; readonly noise: number };

function drawPart(tc: TestCase): number {
  return tc.draw(
    gs.oneOf(
      gs.integers({ minValue: 0, maxValue: 2 }),
      gs.integers({ minValue: 0, maxValue: 3000 }),
    ),
  );
}

function drawTriple(tc: TestCase): Triple {
  return [drawPart(tc), drawPart(tc), drawPart(tc)];
}

function reads(expected: string, installed: string) {
  return {
    readSdkPackageMetadata: async () =>
      JSON.stringify({ version: "0.0.0", claudeCodeVersion: expected }),
    readInstalledClaudeVersion: async () => installed,
  };
}

function inspect(expected: string, installed: string) {
  return inspectClaudeSdkVersions().pipe(
    Effect.provide(ClaudeSdkVersionSources.fromReads(reads(expected, installed))),
  );
}

// Oracle: lexicographic tuple order, decided at the first differing component.
function lexicographicallyGreater(left: Triple, right: Triple): boolean {
  for (const [index, part] of left.entries()) {
    const other = right[index] ?? 0;
    if (part !== other) {
      return part > other;
    }
  }
  return false;
}

async function assertScenario(scenario: Scenario): Promise<void> {
  const wrap = NOISE[scenario.noise] ?? ((version: string) => version);
  const bundled = scenario.bundled.join(".");
  const installed = scenario.installed.join(".");
  const forward = await Effect.runPromise(inspect(wrap(bundled), wrap(installed)));
  const backward = await Effect.runPromise(inspect(wrap(installed), wrap(bundled)));
  assert.equal(forward.installedClaudeCode, installed);
  assert.equal(
    forward.updateSuggested,
    lexicographicallyGreater(scenario.installed, scenario.bundled),
  );
  assert.equal(forward.updateSuggested && backward.updateSuggested, false);
  assert.equal(forward.updateSuggested || backward.updateSuggested, installed !== bundled);
}

function drawScenario(tc: TestCase): Scenario {
  const bundled = drawTriple(tc);
  const installed = tc.draw(gs.booleans()) ? bundled : drawTriple(tc);
  return { bundled, installed, noise: tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) };
}

const UNSAFE = ["9007199254740992", "9007199254740993", "99999999999999999999"];

async function assertUnsafeRejected(unsafe: string, slot: number): Promise<void> {
  const parts = ["1", "2", "3"];
  parts[slot] = unsafe;
  const text = `${parts.join(".")} (Claude Code)`;
  const failure = await Effect.runPromise(Effect.flip(inspect("2.1.0", text)));
  assert.equal(failure._tag, "ClaudeVersionParseError");
  const safe = await Effect.runPromise(inspect("2.1.0", "9007199254740991.0.0"));
  assert.equal(safe.updateSuggested, true);
}

describe("sdk version comparison properties", () => {
  test("update suggestion follows tuple order through noisy version text", async () => {
    await new Hegel(async (tc) => {
      await assertScenario(drawScenario(tc));
    })
      .settings(settings)
      .run();
  });

  test("components above Number.MAX_SAFE_INTEGER are rejected, not mis-compared", async () => {
    await Promise.all(
      UNSAFE.flatMap((unsafe) => [0, 1, 2].map(async (slot) => assertUnsafeRejected(unsafe, slot))),
    );
  });
});
