import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

// Pi aliases an extension's pi-tui import to its own copy, so both share module state such as
// keybindings and the keyboard protocol. npm may install a second copy beside pi-coding-agent's.
// Resolving pi-tui from pi-coding-agent gives tests the same single copy.
const piTui = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve(
  "@earendil-works/pi-tui",
);

export default defineConfig({
  resolve: {
    alias: { "@earendil-works/pi-tui": piTui },
  },
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
