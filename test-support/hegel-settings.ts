import { Database, Hegel } from "@hegeldev/hegel";
import type { Settings, TestCase } from "@hegeldev/hegel";

/** The pull-request gate replays the same inputs on every run. */
const DEFAULT_SEED = 12_345n;
const SEED_LIMIT = 2n ** 64n;

function envSeed(): bigint | undefined {
  const raw = process.env.HEGEL_SEED;
  if (raw === undefined || raw === "") {
    return undefined;
  }
  if (!/^\d+$/u.test(raw) || BigInt(raw) >= SEED_LIMIT) {
    throw new Error(`HEGEL_SEED must be an integer in [0, 2^64), got "${raw}"`);
  }
  return BigInt(raw);
}

function envTestCases(): number | undefined {
  const raw = process.env.HEGEL_TEST_CASES;
  if (raw === undefined || raw === "") {
    return undefined;
  }
  if (!/^[1-9]\d*$/u.test(raw)) {
    throw new Error(`HEGEL_TEST_CASES must be a positive integer, got "${raw}"`);
  }
  return Number(raw);
}

/**
 * Settings for every Hegel property.
 *
 * Without environment variables a property runs `testCases` cases from a fixed seed, so the
 * pull-request gate is deterministic. `HEGEL_SEED` replaces the seed and `HEGEL_TEST_CASES` the case
 * count for every property. The database stays off: a counterexample becomes a regression test.
 */
export function propertySettings(testCases = 200, seed: bigint = DEFAULT_SEED): Settings {
  return {
    testCases: envTestCases() ?? testCases,
    seed: envSeed() ?? seed,
    database: Database.disabled,
  };
}

/**
 * The longest a property may take. `baseMs` covers the property's own case count; a `HEGEL_TEST_CASES`
 * override scales it by the ratio of the new count to `baseCases`, so a longer run never times out
 * merely for being longer.
 */
export function propertyTimeout(baseMs: number, baseCases = 200): number {
  const cases = envTestCases();
  return cases === undefined ? baseMs : Math.ceil(baseMs * Math.max(1, cases / baseCases));
}

/**
 * Runs a property synchronously. A failing example throws from here, so Hegel's report of the shrunk
 * draws reaches the test output. The name matches the lint rule's `assert*` convention.
 */
export function assertHegel(settings: Settings, body: (tc: TestCase) => void): void {
  new Hegel(body).settings(settings).runSync();
}
