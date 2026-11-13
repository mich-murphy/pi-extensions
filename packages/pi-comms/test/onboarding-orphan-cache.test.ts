import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  applyLocal,
  executableDigest,
  reusableExecutable,
  resetLocal,
  setupPaths,
} from "../onboarding/backend.js";
import type { SetupBackend } from "../onboarding/backend.js";
import { defaultChoices, localPlan } from "../onboarding/plan.js";
import { setupCommand } from "../onboarding/setup.js";
import type { ActivatePlan } from "../onboarding/upgrade.js";
import { builtGateway, dialog, nativeFixture, noPins } from "./onboarding-fixtures.js";

const local = "Local only — no remote connections (recommended)";
describe("orphan installation recovery with actual native flock", () => {
  let fixture: Awaited<ReturnType<typeof nativeFixture>>;
  let agent: string;
  beforeEach(async () => {
    fixture = await nativeFixture();
    vi.stubEnv("HOME", fixture.root);
    agent = join(fixture.root, "agent");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(fixture.root, { recursive: true, force: true });
  });
  const plan = () => localPlan(defaultChoices("Orphan"), setupPaths(agent).socket);
  async function orphan(reset: boolean, tamper: boolean) {
    const paths = setupPaths(agent);
    if (reset) {
      await applyLocal(agent, plan(), { acquire: async () => fixture.executable }, () => undefined);
      await resetLocal(agent);
    } else {
      await mkdir(paths.directory, { recursive: true, mode: 0o700 });
      await writeFile(
        paths.installed,
        JSON.stringify({
          executable: fixture.executable,
          sha256: await executableDigest(fixture.executable),
        }),
        { mode: 0o600 },
      );
    }
    const installed = await readFile(paths.installed);
    await rm(fixture.executable);
    const marker = join(fixture.root, "NEVER-EXECUTE");
    if (tamper) {
      await writeFile(
        fixture.executable,
        `#!/bin/sh\nprintf bad > ${JSON.stringify(marker)}\nexit 1\n`,
        { mode: 0o500 },
      );
    }
    const replacement = join(fixture.root, "verified-new");
    await copyFile(builtGateway, replacement);
    await chmod(replacement, 0o500);
    return { paths, installed, marker, replacement };
  }
  test.each([
    [true, false],
    [true, true],
    [false, false],
    [false, true],
  ])(
    "reset=%s tamper=%s: fresh acquisition preserves old descriptor and unknown files",
    async (reset, tamper) => {
      const { paths, installed, marker, replacement } = await orphan(reset, tamper);
      const sentinel = join(paths.directory, "unknown-key-floor");
      await writeFile(sentinel, "retain");
      await expect(reusableExecutable(agent)).resolves.toBeUndefined();
      const acquire = vi.fn<SetupBackend["acquire"]>(async () => replacement);
      const setup = await applyLocal(agent, plan(), { acquire }, () => undefined);
      expect(acquire).toHaveBeenCalledOnce();
      expect(setup.executable).toBe(replacement);
      expect(existsSync(marker)).toBe(false);
      const entries = await readdir(paths.directory);
      const backups = entries.filter((name) => name.startsWith("installed.json.previous-"));
      expect(backups).toHaveLength(1);
      await expect(readFile(join(paths.directory, ...backups))).resolves.toStrictEqual(installed);
      await expect(readFile(sentinel, "utf8")).resolves.toBe("retain");
      expect(existsSync(fixture.executable)).toBe(tamper);
      await resetLocal(agent);
    },
  );
  test("cancel and absent production pin are read-only, including orphan target", async () => {
    const { paths, installed, marker, replacement } = await orphan(false, true);
    const entries = await readdir(paths.directory);
    const acquire = vi.fn<SetupBackend["acquire"]>(async () => replacement);
    const activate = vi.fn<ActivatePlan>();
    await setupCommand(agent, dialog([local, "Cancel — no changes"]), activate, {
      backend: { acquire },
      description: "TEST trusted acquisition",
    });
    const blocked = dialog([local, "APPLY"]);
    await setupCommand(agent, blocked, activate, undefined, undefined, noPins);
    expect(blocked.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Blocked"), "warning");
    expect(acquire).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
    await expect(readdir(paths.directory)).resolves.toStrictEqual(entries);
    await expect(readFile(paths.installed)).resolves.toStrictEqual(installed);
  });
  async function driftCase(drift: string) {
    const state = await orphan(false, true);
    const paths: Record<string, string> = {
      ...state.paths,
      pairing: join(state.paths.directory, "pairing.json"),
      repair: join(state.paths.directory, "repair.json"),
      reset: join(state.paths.directory, "reset.json"),
      target: fixture.executable,
    };
    const acquire = vi.fn<SetupBackend["acquire"]>(async () => {
      const path = paths[drift];
      if (path === undefined) {
        throw new Error("Invalid test drift");
      }
      if (drift === "target") {
        await rm(path);
      }
      await writeFile(path, "external", { mode: 0o500 });
      return state.replacement;
    });
    return {
      ...state,
      acquire,
      expectedInstalled: drift === "installed" ? Buffer.from("external") : state.installed,
    };
  }
  test.each([
    "installed",
    "metadata",
    "adapter",
    "gateway",
    "journal",
    "prepared",
    "pairing",
    "repair",
    "reset",
    "target",
  ])(
    "concurrent %s drift refuses before descriptor replacement or journal effects",
    async (drift) => {
      const { paths, marker, acquire, expectedInstalled } = await driftCase(drift);
      await expect(applyLocal(agent, plan(), { acquire }, () => undefined)).rejects.toThrow(
        /changed|preserved|JSON/u,
      );
      expect(acquire).toHaveBeenCalledOnce();
      expect(existsSync(marker)).toBe(false);
      const entries = await readdir(paths.directory);
      expect(entries.some((name) => /\.(?:previous|staged)-/u.test(name))).toBe(false);
      expect(existsSync(paths.journal)).toBe(drift === "journal");
      await expect(readFile(paths.installed)).resolves.toStrictEqual(expectedInstalled);
    },
  );
  test("valid cache-only interrupted bootstrap reuses its verified helper without acquisition", async () => {
    const paths = setupPaths(agent);
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    const installed = JSON.stringify({
      executable: fixture.executable,
      sha256: await executableDigest(fixture.executable),
    });
    await writeFile(paths.installed, installed, { mode: 0o600 });
    await expect(reusableExecutable(agent)).resolves.toBe(fixture.executable);
    const acquire = vi.fn<SetupBackend["acquire"]>();
    const setup = await applyLocal(agent, plan(), { acquire }, () => undefined);
    expect(acquire).not.toHaveBeenCalled();
    expect(setup.executable).toBe(fixture.executable);
    await expect(readFile(paths.installed, "utf8")).resolves.toBe(installed);
    await resetLocal(agent);
  });
  test("malformed orphan metadata is not classified as a recoverable descriptor", async () => {
    const { paths } = await orphan(false, true);
    await writeFile(
      paths.installed,
      JSON.stringify({ executable: fixture.executable, sha256: "not a digest" }),
    );
    await expect(reusableExecutable(agent)).rejects.toThrow("sha256");
    const acquire = vi.fn<SetupBackend["acquire"]>();
    await expect(applyLocal(agent, plan(), { acquire }, () => undefined)).rejects.toThrow("sha256");
    expect(acquire).not.toHaveBeenCalled();
  });
  test("committed metadata never gets orphan fallback when its helper is lost", async () => {
    await applyLocal(agent, plan(), { acquire: async () => fixture.executable }, () => undefined);
    await rm(fixture.executable);
    await expect(reusableExecutable(agent)).rejects.toThrow("ENOENT");
    const acquire = vi.fn<SetupBackend["acquire"]>();
    await expect(applyLocal(agent, plan(), { acquire }, () => undefined)).rejects.toThrow(
      "preserved",
    );
    expect(acquire).not.toHaveBeenCalled();
  });
  test("pending projections are never silently reset or acquired over", async () => {
    const { paths, installed } = await orphan(false, true);
    await writeFile(paths.prepared, "pending");
    const acquire = vi.fn<SetupBackend["acquire"]>(async () => fixture.executable);
    await expect(applyLocal(agent, plan(), { acquire }, () => undefined)).rejects.toThrow(
      "preserved",
    );
    expect(acquire).not.toHaveBeenCalled();
    await expect(readFile(paths.prepared, "utf8")).resolves.toBe("pending");
    await expect(readFile(paths.installed)).resolves.toStrictEqual(installed);
  });
});
