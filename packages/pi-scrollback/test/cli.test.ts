import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { readManifest } from "../../../test-support/pi-manifest";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const host = join(repo, "node_modules/@earendil-works/pi-coding-agent");
const manifest = readManifest(join(host, "package.json"));
const cli = resolve(host, manifest.bin.pi);

const decodeDependencies = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      devDependencies: Schema.Struct({ "@earendil-works/pi-coding-agent": Schema.String }),
    }),
  ),
);

const { devDependencies } = decodeDependencies(readFileSync(join(repo, "package.json"), "utf8"));
const pinned = devDependencies["@earendil-works/pi-coding-agent"];
const tmuxAvailable = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const skipJourney = !tmuxAvailable && process.env.CI !== "true";

describe("real isolated Pi CLI", () => {
  test("loads the extension in the exact pinned offline CLI without calling a provider", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scrollback-cli-"));
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
          join(repo, "packages/pi-scrollback/index.ts"),
          "--list-models",
          "scrollback-nonexistent-model",
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

  test("passes the native PTY history, resize, reload and mode journey", (context) => {
    context.skip(
      skipJourney,
      "tmux is not installed; the native PTY journey needs it (mandatory on CI)",
    );

    const result = spawnSync(
      process.execPath,
      [join(repo, "packages/pi-scrollback/test/fixtures/native-journey.ts"), host],
      { cwd: repo, encoding: "utf8", timeout: 300_000 },
    );

    expect(result.error).toBeUndefined();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    expect(result.stdout).toContain('"providerSafety"');
  }, 305_000);
});
