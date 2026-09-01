import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/claude-sdk-provider/test/**/*.live.ts"],
    testTimeout: 120_000,
  },
});
