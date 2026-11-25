import { randomBytes } from "node:crypto";
import { readFileSync, globSync } from "node:fs";
import { defineConfig } from "vitest/config";
import base from "./vitest.config";

const envOr = (name: string, fallback: () => string): string => {
  const value = process.env[name];

  return value === undefined || value === "" ? fallback() : value;
};

const seed = envOr("HEGEL_SEED", () => BigInt(`0x${randomBytes(8).toString("hex")}`).toString());
const testCases = envOr("HEGEL_TEST_CASES", () => "2000");

process.env.HEGEL_SEED = seed;

process.env.HEGEL_TEST_CASES = testCases;

process.env.HEGEL_REPORT_MULTIPLE_FAILURES ??= "true";

process.stdout.write(`Hegel properties: HEGEL_SEED=${seed} HEGEL_TEST_CASES=${testCases}\n`);

const files = globSync("packages/*/test/**/*.test.ts").filter((file) =>
  readFileSync(file, "utf8").includes("@hegeldev/hegel"),
);

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: files,
    testTimeout: 5000 * Math.max(1, Number(testCases) / 200),
    coverage: { enabled: false },
  },
});
