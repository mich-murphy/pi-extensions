import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

const piTuiSharedWithPiCodingAgent = createRequire(
  import.meta.resolve("@earendil-works/pi-coding-agent"),
).resolve("@earendil-works/pi-tui");

const piAiExtensionView = new URL(
  "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/pi-ai-extension-view.js",
  import.meta.url,
).pathname;

if (!existsSync(piAiExtensionView)) {
  throw new Error(
    `Pi moved its pi-ai extension view; tests would load a different pi-ai than Pi gives extensions: ${piAiExtensionView}`,
  );
}

const SERIALIZE_CPU_HEAVY_NATIVE_CLI_BOOT_FILES_ON_SHARED_CI_RUNNERS = process.env.CI === "true";

export default defineConfig({
  resolve: {
    alias: [
      { find: "@earendil-works/pi-tui", replacement: piTuiSharedWithPiCodingAgent },
      { find: /^@earendil-works\/pi-ai$/u, replacement: piAiExtensionView },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    setupFiles: ["test-support/isolate-git.ts"],
    fileParallelism: !SERIALIZE_CPU_HEAVY_NATIVE_CLI_BOOT_FILES_ON_SHARED_CI_RUNNERS,
    maxWorkers: 2,
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
