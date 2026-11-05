import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

// Pi aliases an extension's pi-tui import to its own copy, so both share module state such as
// keybindings and the keyboard protocol. npm may install a second copy beside pi-coding-agent's.
// Resolving pi-tui from pi-coding-agent gives tests the same single copy.
const piTui = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve(
  "@earendil-works/pi-tui",
);

// Pi also maps an extension's "@earendil-works/pi-ai" import (root only) to its extension view: pi-ai
// compat plus TypeBox's Type and a TypeBox-typed StringEnum. Tests load the same module Pi does.
const piAiExtensionView = new URL(
  "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/pi-ai-extension-view.js",
  import.meta.url,
).pathname;

export default defineConfig({
  resolve: {
    alias: [
      { find: "@earendil-works/pi-tui", replacement: piTui },
      { find: /^@earendil-works\/pi-ai$/u, replacement: piAiExtensionView },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Native CLI boot tests are CPU-heavy under V8 coverage.
    // Serialize files on shared CI runners; retain every assertion, timeout and coverage gate.
    fileParallelism: process.env.CI !== "true",
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
