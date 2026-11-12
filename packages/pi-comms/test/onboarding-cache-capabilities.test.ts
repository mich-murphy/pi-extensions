import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AdapterSession } from "../adapter/session.js";
import { freshId } from "../adapter/transport.js";
import {
  applyLocal,
  executableDigest,
  reusableExecutable,
  resetLocal,
  reloadManagedLauncher,
  setupPaths,
} from "../onboarding/backend.js";
import type { SetupBackend } from "../onboarding/backend.js";
import {
  GATEWAY_LOCAL_SETUP_CAPABILITIES,
  GATEWAY_REMOTE_SETUP_CAPABILITIES,
} from "../onboarding/catalog.js";
import { defaultChoices, localPlan } from "../onboarding/plan.js";
import type { LocalPlan } from "../onboarding/plan.js";
import { repairInstallation } from "../onboarding/repair.js";
import {
  decodeCached,
  decodeManaged,
  decodeGateway,
  decodePairing,
  parseJson,
} from "../onboarding/schema.js";
import { setupCommand } from "../onboarding/setup.js";
import type { ActivatePlan } from "../onboarding/upgrade.js";
import { dialog, nativeFixture, nativeUntil } from "./onboarding-fixtures.js";

const local = "Local only — no remote connections (recommended)";
const remote = [
  "Configure one remote peer",
  "Create a new trusted pair",
  "remote-peer",
  "Listen for peer",
  "127.0.0.1:7443",
];

const without = (capability: string) =>
  GATEWAY_LOCAL_SETUP_CAPABILITIES.filter((value) => value !== capability);

function requiredField(output: Record<string, unknown>, key: string): string {
  const value = output[key];
  if (typeof value !== "string") {
    throw new TypeError("Missing native pairing output");
  }
  return value;
}

describe("capability-incompatible orphan cache: simulated old VERSION only, actual NEW native flock", () => {
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
  const plan = () => localPlan(defaultChoices("Capabilities"), setupPaths(agent).socket);
  async function versionOnlyCache(
    capabilities: readonly string[],
    afterReset = false,
    delegateLock = false,
  ) {
    const paths = setupPaths(agent);
    if (afterReset) {
      await applyLocal(agent, plan(), { acquire: async () => fixture.executable }, () => undefined);
      await resetLocal(agent);
    } else {
      await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    }
    const executable = join(fixture.root, "SIMULATED-old-version-only");
    const marker = join(fixture.root, "OLD-LOCK-PAIR-OR-SPAWN-INVOKED");
    const lockLog = join(fixture.root, "SIMULATED-old-delegated-native-locks");
    const lock = delegateLock
      ? `if [ "$1" = "--setup-lock" ]; then\n  printf 'lock\\n' >> ${JSON.stringify(lockLog)}\n  exec ${JSON.stringify(fixture.executable)} "$@"\nfi\n`
      : "";
    const output = JSON.stringify({
      name: "pi-gateway",
      wireVersions: [1],
      capabilities: ["managed-on-demand-v1", ...capabilities],
    });
    // No genuine old-native binary is available. This trusted historic-helper seam
    // supports read-only version inspection; reset-only tests may explicitly delegate
    // setup-lock to the real new native binary. Every other operation marks failure.
    await rm(executable, { force: true });
    await writeFile(
      executable,
      `#!/bin/sh\nif [ "$#" -eq 2 ] && [ "$1" = "--version" ] && [ "$2" = "--json" ]; then\n  printf '%s\\n' '${output}'\n  exit 0\nfi\n${lock}printf '%s\\n' "$*" > ${JSON.stringify(marker)}\nexit 97\n`,
      { mode: 0o500 },
    );
    const installed = JSON.stringify({ executable, sha256: await executableDigest(executable) });
    await writeFile(paths.installed, installed, { mode: 0o600 });
    return { paths, executable, marker, installed, lockLog };
  }
  test.each(["config-generation-v1", "gateway-control-v1"])(
    "hash-valid post-reset orphan missing %s acquires NEW native helper and archives exact descriptor",
    async (missing) => {
      const { paths, marker, installed, executable } = await versionOnlyCache(
        without(missing),
        true,
      );
      const oldBytes = await readFile(executable);
      await expect(reusableExecutable(agent)).resolves.toBeUndefined();
      const acquire = vi.fn<SetupBackend["acquire"]>(async () => fixture.executable);
      const setup = await applyLocal(agent, plan(), { acquire }, () => undefined);
      expect(acquire).toHaveBeenCalledOnce();
      expect(setup.executable).toBe(fixture.executable);
      expect(existsSync(marker)).toBe(false);
      const entries = await readdir(paths.directory);
      const backups = entries.filter((name) => name.startsWith("installed.json.previous-"));
      expect(backups).toHaveLength(1);
      await expect(readFile(join(paths.directory, ...backups), "utf8")).resolves.toBe(installed);
      await expect(readFile(executable)).resolves.toStrictEqual(oldBytes);
      await resetLocal(agent);
    },
  );
  test.each(["config-generation-v1", "gateway-control-v1"])(
    "missing %s: Cancel and production no-pin Apply are read-only and acquire nothing",
    async (missing) => {
      const { paths, marker, installed } = await versionOnlyCache(without(missing));
      const entries = await readdir(paths.directory);
      const acquire = vi.fn<SetupBackend["acquire"]>(async () => fixture.executable);
      const activate = vi.fn<ActivatePlan>();
      await setupCommand(agent, dialog([local, "Cancel — no changes"]), activate, {
        backend: { acquire },
        description: "TEST fresh verified source",
      });
      const blocked = dialog([local, "APPLY"]);
      await setupCommand(agent, blocked, activate);
      expect(blocked.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Blocked"), "warning");
      expect(acquire).not.toHaveBeenCalled();
      expect(activate).not.toHaveBeenCalled();
      expect(existsSync(marker)).toBe(false);
      await expect(readdir(paths.directory)).resolves.toStrictEqual(entries);
      await expect(readFile(paths.installed, "utf8")).resolves.toBe(installed);
    },
  );
  test("remote discovery does not reuse a hash-valid LOCAL-only cache; no pin stays blocked without effects", async () => {
    const { paths, marker, installed } = await versionOnlyCache(GATEWAY_LOCAL_SETUP_CAPABILITIES);
    await expect(reusableExecutable(agent)).resolves.toBeDefined();
    await expect(
      reusableExecutable(agent, GATEWAY_REMOTE_SETUP_CAPABILITIES),
    ).resolves.toBeUndefined();
    const entries = await readdir(paths.directory);
    const activate = vi.fn<ActivatePlan>();
    const blocked = dialog([...remote, "APPLY"]);
    await setupCommand(agent, blocked, activate);
    expect(blocked.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Blocked"), "warning");
    expect(activate).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
    await expect(readdir(paths.directory)).resolves.toStrictEqual(entries);
    await expect(readFile(paths.installed, "utf8")).resolves.toBe(installed);
  });
  test("remote Apply bypasses LOCAL-only cached helper and uses actual NEW native lock/pairing", async () => {
    const { paths, marker, installed } = await versionOnlyCache(GATEWAY_LOCAL_SETUP_CAPABILITIES);
    const acquire = vi.fn<SetupBackend["acquire"]>(async () => fixture.executable);
    const activate = vi.fn<ActivatePlan>();
    const ctx = dialog([...remote, "APPLY"]);
    await setupCommand(agent, ctx, activate, {
      backend: { acquire },
      description: "TEST full-capability native replacement",
    });
    expect(acquire).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledOnce();
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(paths.directory, "pairing.json"))).toBe(true);
    const entries = await readdir(paths.directory);
    const backups = entries.filter((name) => name.startsWith("installed.json.previous-"));
    expect(backups).toHaveLength(1);
    await expect(readFile(join(paths.directory, ...backups), "utf8")).resolves.toBe(installed);
    await resetLocal(agent);
  });
  test("remote NEW helper missing pairing is refused before native lock, journal or prepare effects", async () => {
    const { paths, executable, marker, installed } = await versionOnlyCache(
      GATEWAY_LOCAL_SETUP_CAPABILITIES,
    );
    const entries = await readdir(paths.directory);
    const acquire = vi.fn<SetupBackend["acquire"]>(async () => executable);
    const prepare = vi.fn<(executable: string, plan: LocalPlan) => Promise<LocalPlan>>();
    await expect(applyLocal(agent, plan(), { acquire }, () => undefined, prepare)).rejects.toThrow(
      "capability",
    );
    expect(acquire).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
    await expect(readdir(paths.directory)).resolves.toStrictEqual(entries);
    await expect(readFile(paths.installed, "utf8")).resolves.toBe(installed);
  });
  test("tampered old helper is not even VERSION-probed before actual NEW native recovery", async () => {
    const { paths, executable, marker, installed } = await versionOnlyCache(
      without("config-generation-v1"),
    );
    await rm(executable);
    await writeFile(
      executable,
      `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\nexit 1\n`,
      { mode: 0o500 },
    );
    await expect(reusableExecutable(agent)).resolves.toBeUndefined();
    const acquire = vi.fn<SetupBackend["acquire"]>(async () => fixture.executable);
    await applyLocal(agent, plan(), { acquire }, () => undefined);
    expect(acquire).toHaveBeenCalledOnce();
    expect(existsSync(marker)).toBe(false);
    const entries = await readdir(paths.directory);
    const backups = entries.filter((name) => name.startsWith("installed.json.previous-"));
    await expect(readFile(join(paths.directory, ...backups), "utf8")).resolves.toBe(installed);
    await resetLocal(agent);
  });
  test("incompatible committed cache never selects automatic orphan reacquisition", async () => {
    await applyLocal(agent, plan(), { acquire: async () => fixture.executable }, () => undefined);
    const { paths, marker, installed } = await versionOnlyCache(without("config-generation-v1"));
    const metadata = await readFile(paths.metadata);
    const entries = await readdir(paths.directory);
    const acquire = vi.fn<SetupBackend["acquire"]>(async () => fixture.executable);
    await expect(reusableExecutable(agent)).rejects.toThrow("capability");
    await expect(applyLocal(agent, plan(), { acquire }, () => undefined)).rejects.toThrow(
      "preserved",
    );
    expect(acquire).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
    await expect(readFile(paths.installed, "utf8")).resolves.toBe(installed);
    await expect(readFile(paths.metadata)).resolves.toStrictEqual(metadata);
    await expect(readdir(paths.directory)).resolves.toStrictEqual(entries);
  });
  async function maskCommitted(capabilities: readonly string[]) {
    const masked = await versionOnlyCache(capabilities, false, true);
    const prior = decodeManaged(parseJson(await readFile(masked.paths.metadata)));
    const cache = decodeCached(parseJson(masked.installed));
    const record = { ...prior, executable: cache.executable, executableSha256: cache.sha256 };
    await writeFile(masked.paths.metadata, JSON.stringify(record));
    return { ...masked, record };
  }
  async function committedMask(capabilities: readonly string[]) {
    await applyLocal(agent, plan(), { acquire: async () => fixture.executable }, () => undefined);
    return maskCommitted(capabilities);
  }
  test.each(["config-generation-v1", "gateway-control-v1"])(
    "committed old helper missing %s can RESET through a version-mask seam delegating actual native lock",
    async (missing) => {
      const { paths, executable, marker, installed, lockLog } = await committedMask(
        without(missing),
      );
      const key = join(paths.directory, "retained-key");
      const floor = join(paths.directory, "retained-floor");
      await writeFile(key, "key sentinel");
      await writeFile(floor, "floor sentinel");
      const oldBytes = await readFile(executable);
      await resetLocal(agent);
      expect(existsSync(paths.adapter)).toBe(false);
      expect(existsSync(paths.metadata)).toBe(false);
      expect(existsSync(paths.gateway)).toBe(false);
      await expect(readFile(paths.installed, "utf8")).resolves.toBe(installed);
      await expect(readFile(key, "utf8")).resolves.toBe("key sentinel");
      await expect(readFile(floor, "utf8")).resolves.toBe("floor sentinel");
      await expect(readFile(executable)).resolves.toStrictEqual(oldBytes);
      await expect(readFile(lockLog, "utf8")).resolves.toBe("lock\n");
      expect(existsSync(marker)).toBe(false);
    },
  );
  test("RESET without verified lock capability refuses without fallback or archive effects", async () => {
    const { paths, marker, lockLog } = await committedMask([]);
    const metadata = await readFile(paths.metadata);
    const entries = await readdir(paths.directory);
    await expect(resetLocal(agent)).rejects.toThrow("capability");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(lockLog)).toBe(false);
    await expect(readFile(paths.metadata)).resolves.toStrictEqual(metadata);
    await expect(readdir(paths.directory)).resolves.toStrictEqual(entries);
  });
  test.each(["config-generation-v1", "gateway-control-v1"])(
    "committed missing %s offers explicit repair: cancel/no-pin acquire zero with unchanged config",
    async (missing) => {
      const { paths, marker, lockLog } = await committedMask(without(missing));
      const owned = [paths.metadata, paths.installed, paths.adapter, paths.gateway];
      const before = await Promise.all(owned.map(async (path) => readFile(path)));
      const entries = await readdir(paths.directory);
      const acquire = vi.fn<SetupBackend["acquire"]>(async () => fixture.executable);
      const activate = vi.fn<ActivatePlan>();
      const cancelled = dialog(["Cancel — no changes"]);
      await setupCommand(agent, cancelled, activate, {
        backend: { acquire },
        description: "TEST trusted repair",
      });
      expect(cancelled.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Repair cancelled"),
        "info",
      );
      const blocked = dialog(["APPLY"]);
      await setupCommand(agent, blocked, activate);
      expect(blocked.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Repair blocked"),
        "warning",
      );
      expect(acquire).not.toHaveBeenCalled();
      expect(activate).not.toHaveBeenCalled();
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(lockLog)).toBe(false);
      await expect(Promise.all(owned.map(async (path) => readFile(path)))).resolves.toStrictEqual(
        before,
      );
      await expect(readdir(paths.directory)).resolves.toStrictEqual(entries);
    },
  );
  test("compatible committed helper is healthy and does not offer an update just for a new version", async () => {
    await applyLocal(agent, plan(), { acquire: async () => fixture.executable }, () => undefined);
    const acquisition = vi.fn<Parameters<typeof repairInstallation>[2]>();
    const ctx = dialog(["APPLY"]);
    await expect(repairInstallation(agent, ctx, acquisition)).resolves.toBe(false);
    expect(acquisition).not.toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });
  test("approved old-cap repair uses actual NEW native lock and retains live nonce/state/config without control", async () => {
    const selected = plan();
    const setup = await applyLocal(
      agent,
      selected,
      { acquire: async () => fixture.executable },
      () => undefined,
    );
    const session = new AdapterSession(
      selected.adapter,
      { machineId: selected.adapter.machineId, sessionId: freshId(), runtimeNonce: freshId() },
      { sendMessage: () => undefined },
      () => undefined,
      () => undefined,
      reloadManagedLauncher(agent, selected.adapter, setup),
    );
    try {
      await session.reconnect();
      const publication = session.state.publish({
        scopeId: "local",
        key: "retained",
        record: {
          category: "context",
          title: "Keep repair state",
          summary: "same runtime",
          content: "same publication",
          format: "text",
          preparation: "authored",
        },
      });
      expect(publication.tag).toBe("ok");
      const state = session.state;
      const identity = session.peer;
      const beforeStatus = session.status();
      const beforeRead = state.read({ caller: identity, scopeId: "local", key: "retained" });
      const inode = await stat(setup.socketPath);
      const { paths, marker, lockLog, record } = await maskCommitted(
        without("config-generation-v1"),
      );
      const preserved = [paths.adapter, paths.gateway];
      const before = await Promise.all(preserved.map(async (path) => readFile(path)));
      const floor = join(paths.directory, "retained-floor-key");
      await writeFile(floor, "unchanged");
      const acquire = vi.fn<SetupBackend["acquire"]>(async () => fixture.executable);
      const activate = vi.fn<ActivatePlan>();
      const reconnect = vi.fn<() => Promise<void>>(async () => session.reconnect());
      await setupCommand(
        agent,
        dialog(["APPLY"]),
        activate,
        { backend: { acquire }, description: "TEST required-capability repair" },
        reconnect,
      );
      expect(acquire).toHaveBeenCalledOnce();
      expect(reconnect).toHaveBeenCalledOnce();
      expect(activate).not.toHaveBeenCalled();
      expect(session.peer).toBe(identity);
      expect(session.state).toBe(state);
      expect(session.status()).toMatchObject({
        connected: true,
        scopes: beforeStatus.scopes,
        publications: beforeStatus.publications,
        revision: beforeStatus.revision,
      });
      expect(state.read({ caller: identity, scopeId: "local", key: "retained" })).toStrictEqual(
        beforeRead,
      );
      const afterInode = await stat(setup.socketPath);
      expect(afterInode.ino).toBe(inode.ino);
      const after = decodeManaged(parseJson(await readFile(paths.metadata)));
      expect(after).toStrictEqual({
        ...record,
        executable: fixture.executable,
        executableSha256: await executableDigest(fixture.executable),
      });
      await expect(
        Promise.all(preserved.map(async (path) => readFile(path))),
      ).resolves.toStrictEqual(before);
      await expect(readFile(floor, "utf8")).resolves.toBe("unchanged");
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(lockLog)).toBe(false);
    } finally {
      session.close();
      await nativeUntil(async () => !existsSync(setup.socketPath));
    }
  });
  test("repaired helper with failed guarded reconnect reports pending and directs an explicit reviewed activation", async () => {
    const { marker, lockLog } = await committedMask(without("config-generation-v1"));
    const acquire = vi.fn<SetupBackend["acquire"]>(async () => fixture.executable);
    const ctx = dialog(["APPLY"]);
    await setupCommand(
      agent,
      ctx,
      vi.fn<ActivatePlan>(),
      { backend: { acquire }, description: "TEST repair" },
      async () => {
        throw new Error("Explicit test seam: older live gateway rejects guarded registration");
      },
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("guarded activation pending or unconfirmed"),
      "warning",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("/comms setup → Activate saved configuration"),
      "warning",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("no control request was sent"),
      "warning",
    );
    expect(acquire).toHaveBeenCalledOnce();
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(lockLog)).toBe(false);
  });
  test("owned pending Join without gateway.remote still requires pairing capability for explicit repair", async () => {
    const creator = join(fixture.root, "creator");
    await setupCommand(creator, dialog([...remote, "APPLY"]), vi.fn<ActivatePlan>(), {
      backend: { acquire: async () => fixture.executable },
      description: "TEST actual native pair creation",
    });
    const pair = decodePairing(
      parseJson(await readFile(join(setupPaths(creator).directory, "pairing.json"))),
    );
    const offer = requiredField(pair.output, "offerPath");
    const root = requiredField(pair.output, "rootSha256");
    await setupCommand(
      agent,
      dialog([
        "Configure one remote peer",
        "Join a new trusted pair",
        offer,
        root,
        "Connect to peer",
        "127.0.0.1:7443",
        "APPLY",
      ]),
      vi.fn<ActivatePlan>(),
      {
        backend: { acquire: async () => fixture.executable },
        description: "TEST actual native pending Join",
      },
    );
    const { paths, executable, marker, lockLog } = await maskCommitted(
      GATEWAY_LOCAL_SETUP_CAPABILITIES,
    );
    const gateway = decodeGateway(parseJson(await readFile(paths.gateway)));
    expect(gateway.remote).toBeUndefined();
    const owned = [paths.adapter, paths.gateway, join(paths.directory, "pairing.json")];
    const before = await Promise.all(owned.map(async (path) => readFile(path)));
    const metadata = await readFile(paths.metadata);
    const acquire = vi
      .fn<SetupBackend["acquire"]>()
      .mockResolvedValueOnce(executable)
      .mockResolvedValue(fixture.executable);
    const acquisition = vi.fn<Parameters<typeof repairInstallation>[2]>(async () => ({
      backend: { acquire },
      description: "TEST pending pairing repair",
    }));
    await repairInstallation(agent, dialog(["Cancel — no changes"]), acquisition);
    expect(acquisition).toHaveBeenCalledWith(true);
    expect(acquire).not.toHaveBeenCalled();
    await expect(repairInstallation(agent, dialog(["APPLY"]), acquisition)).rejects.toThrow(
      "capability",
    );
    await expect(readFile(paths.metadata)).resolves.toStrictEqual(metadata);
    await repairInstallation(agent, dialog(["APPLY"]), acquisition);
    expect(acquire).toHaveBeenCalledTimes(2);
    await expect(Promise.all(owned.map(async (path) => readFile(path)))).resolves.toStrictEqual(
      before,
    );
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(lockLog)).toBe(false);
  });
  async function driftDuringAcquire(drift: string) {
    const state = await versionOnlyCache(without("config-generation-v1"));
    const acquire = vi.fn<SetupBackend["acquire"]>(async () => {
      if (drift === "target") {
        await rm(state.executable);
        await writeFile(
          state.executable,
          `#!/bin/sh\nprintf executed > ${JSON.stringify(state.marker)}\n`,
          { mode: 0o500 },
        );
      } else {
        await writeFile(
          drift === "installed" ? state.paths.installed : state.paths.prepared,
          "concurrent external bytes",
        );
      }
      return fixture.executable;
    });
    return { ...state, acquire };
  }
  test.each(["installed", "prepared", "target"])(
    "incompatible cache still refuses concurrent %s drift",
    async (drift) => {
      const { paths, marker, acquire } = await driftDuringAcquire(drift);
      await expect(applyLocal(agent, plan(), { acquire }, () => undefined)).rejects.toThrow(
        /JSON|changed|preserved/u,
      );
      expect(acquire).toHaveBeenCalledOnce();
      expect(existsSync(marker)).toBe(false);
      const entries = await readdir(paths.directory);
      expect(entries.filter((name) => /\.(?:previous|staged)-/u.test(name))).toHaveLength(0);
      expect(existsSync(paths.journal)).toBe(false);
    },
  );
});
