import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const host = join(repo, "node_modules/@earendil-works/pi-coding-agent");
function jsonObject(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected manifest object");
  }
  return Object.fromEntries(Object.entries(value));
}
const manifest = jsonObject(join(host, "package.json"));
const bin = manifest.bin;
if (typeof bin !== "object" || bin === null || !("pi" in bin) || typeof bin.pi !== "string") {
  throw new Error("Missing Pi executable");
}
const cli = resolve(host, bin.pi);
const dependencies = jsonObject(join(repo, "package.json")).devDependencies;
if (
  typeof dependencies !== "object" ||
  dependencies === null ||
  !("@earendil-works/pi-coding-agent" in dependencies)
) {
  throw new Error("Missing Pi pin");
}
const pinned = dependencies["@earendil-works/pi-coding-agent"];
const tmuxAvailable = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const skipJourney = !tmuxAvailable && process.env.CI !== "true";

describe("real isolated Pi CLI", () => {
  test("loads the extension in the exact pinned offline CLI without calling a provider", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scroll-context-cli-"));
    const agent = join(root, "agent");
    mkdirSync(agent);
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ enableInstallTelemetry: false }));
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      PI_CODING_AGENT_DIR: agent,
      PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    };
    try {
      expect(manifest.version).toBe(pinned);
      const result = spawnSync(
        process.execPath,
        [
          cli,
          "--offline",
          "--no-extensions",
          "--no-skills",
          "--no-context-files",
          "--no-mcp",
          "--extension",
          join(repo, "packages/pi-scroll-context/index.ts"),
          "--list-models",
          "scroll-context-nonexistent-model",
        ],
        { cwd: root, env, encoding: "utf8", timeout: 30_000 },
      );
      expect(result.error).toBeUndefined();
      assert.equal(result.status, 0, result.stderr + result.stdout);
      expect(result.stderr + result.stdout).not.toMatch(
        /Failed to load extension|Extension error/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 35_000);

  // The journey drives a real tmux PTY. tmux is an external binary, so its absence is an environment
  // precondition, not a flake: locally the test is reported as skipped with the reason below, while
  // on CI (CI=true, ubuntu-latest runners ship tmux) a missing tmux is not skipped and fails loudly.
  test("passes the native PTY history, resize, reload and mode journey", (context) => {
    context.skip(
      skipJourney,
      "tmux is not installed; the native PTY journey needs it (mandatory on CI)",
    );
    const result = spawnSync(
      process.execPath,
      [join(repo, "packages/pi-scroll-context/test/fixtures/native-journey.ts"), host],
      // About 10 s unloaded; the waits inside are condition-based with a 120 s hang guard each, and
      // this outer bound sits above that guard rather than racing it.
      { cwd: repo, encoding: "utf8", timeout: 300_000 },
    );
    expect(result.error).toBeUndefined();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    expect(result.stdout).toContain('"providerSafety"');
  }, 305_000);
});
