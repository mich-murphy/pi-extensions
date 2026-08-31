import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      reportsDirectory: "coverage",
      include: ["packages/**/*.ts"],
      exclude: ["packages/*/test/**"],
      thresholds: {
        branches: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});
