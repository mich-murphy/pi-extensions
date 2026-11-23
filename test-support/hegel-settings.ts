import { Database, Hegel } from "@hegeldev/hegel";
import type { Settings, TestCase } from "@hegeldev/hegel";

const PULL_REQUEST_GATE_REPLAY_SEED = 12_345n;
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

export function propertySettings(
  testCases = 200,
  seed: bigint = PULL_REQUEST_GATE_REPLAY_SEED,
): Settings {
  return {
    testCases: envTestCases() ?? testCases,
    seed: envSeed() ?? seed,
    database: Database.disabled,
  };
}

export function propertyTimeout(baseMs: number, baseCases = 200): number {
  const cases = envTestCases();
  return cases === undefined ? baseMs : Math.ceil(baseMs * Math.max(1, cases / baseCases));
}

export function assertHegel(settings: Settings, body: (tc: TestCase) => void): void {
  new Hegel(body).settings(settings).runSync();
}
