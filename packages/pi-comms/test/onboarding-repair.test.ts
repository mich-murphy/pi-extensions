import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GatewayClient } from "../adapter/client.js";
import { freshId } from "../adapter/transport.js";
import { MAX_BINARY } from "../onboarding/artifact.js";
import type { SetupBackend } from "../onboarding/backend.js";
import {
  applyLocal,
  executableDigest,
  readManaged,
  reloadManagedLauncher,
  resetLocal,
  setupPaths,
} from "../onboarding/backend.js";
import { digest } from "../onboarding/files.js";
import { defaultChoices, localPlan } from "../onboarding/plan.js";
import { decodeManaged, parseJson } from "../onboarding/schema.js";
import { setupCommand } from "../onboarding/setup.js";
import type { ActivatePlan } from "../onboarding/upgrade.js";
import { builtGateway, dialog, nativeFixture, nativeUntil } from "./onboarding-fixtures.js";

type Damage = "missing" | "script" | "fifo" | "symlink" | "oversized";
async function damage(path: string, kind: Damage, marker: string) {
  await rm(path);
  if (kind === "missing") {
    return;
  }
  if (kind === "fifo") {
    execFileSync("/usr/bin/mkfifo", [path]);
    return;
  }
  if (kind === "symlink") {
    await symlink(builtGateway, path);
    return;
  }
  if (kind === "oversized") {
    const file = await open(path, "wx", 0o500);
    try {
      await file.truncate(MAX_BINARY + 1);
    } finally {
      await file.close();
    }
    return;
  }
  const staged = `${path}.replacement`;
  await writeFile(staged, `#!/bin/sh\nprintf compromised > ${JSON.stringify(marker)}\nexit 1\n`, {
    mode: 0o500,
  });
  await rename(staged, path);
}
describe("explicit owned installation repair with actual native helper", () => {
  let fixture: Awaited<ReturnType<typeof nativeFixture>>;
  beforeEach(async () => {
    fixture = await nativeFixture();
    vi.stubEnv("HOME", fixture.root);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(fixture.root, { recursive: true, force: true });
  });
  test.each(["missing", "script", "fifo", "symlink", "oversized"] as const)(
    "%s is never executed: cancel is inert, Apply repairs, same client reconnects and reset works",
    async (kind) => {
      const agent = join(fixture.root, "agent");
      const selected = localPlan(defaultChoices("Repair"), setupPaths(agent).socket);
      const setup = await applyLocal(
        agent,
        selected,
        { acquire: async () => fixture.executable },
        () => undefined,
      );
      const peer = {
        machineId: selected.adapter.machineId,
        sessionId: freshId(),
        runtimeNonce: freshId(),
      };
      const live = new GatewayClient({
        config: selected.adapter,
        peer,
        incoming: () => {
          throw new Error("Unexpected authored request");
        },
        statusChanged: () => undefined,
        ensureGateway: reloadManagedLauncher(agent, selected.adapter, setup),
      });
      const paths = setupPaths(agent);
      const marker = join(fixture.root, "UNTRUSTED-WAS-EXECUTED");
      const sentinel = join(paths.directory, "retained-key-floor-sentinel");
      await writeFile(sentinel, "retain bytes");
      const replacement = join(fixture.root, "new-verified-gateway");
      await copyFile(builtGateway, replacement);
      await chmod(replacement, 0o500);
      const acquire = vi.fn<SetupBackend["acquire"]>(async () => replacement);
      const activate = vi.fn<ActivatePlan>();
      const reconnect = vi.fn<() => Promise<void>>(async () => {
        await live.reconnect();
      });
      const owned = [paths.adapter, paths.gateway, paths.metadata, paths.installed, sentinel];
      try {
        await live.reconnect();
        await damage(fixture.executable, kind, marker);
        const start = performance.now();
        await expect(readManaged(agent, selected.adapter)).rejects.toThrow(
          /ENOENT|ELOOP|Expected bounded|Setup executable changed/u,
        );
        expect(performance.now() - start).toBeLessThan(1000);
        const before = await Promise.all(owned.map(async (path) => readFile(path)));
        const entries = await readdir(paths.directory);
        await setupCommand(
          agent,
          dialog(["Cancel — no changes"]),
          activate,
          {
            backend: { acquire },
            description: "Explicit TEST repair acquisition of immutable native fixture",
          },
          reconnect,
        );
        expect(acquire).not.toHaveBeenCalled();
        expect(reconnect).not.toHaveBeenCalled();
        await expect(readdir(paths.directory)).resolves.toStrictEqual(entries);
        await expect(Promise.all(owned.map(async (path) => readFile(path)))).resolves.toStrictEqual(
          before,
        );
        await setupCommand(
          agent,
          dialog(["APPLY"]),
          activate,
          {
            backend: { acquire },
            description: "Explicit TEST repair acquisition of immutable native fixture",
          },
          reconnect,
        );
        expect(acquire).toHaveBeenCalledOnce();
        expect(reconnect).toHaveBeenCalledOnce();
        expect(activate).not.toHaveBeenCalled();
        expect(existsSync(marker)).toBe(false);
        const repaired = await readManaged(agent, selected.adapter);
        expect(repaired?.executable).toBe(replacement);
        await expect(readFile(paths.adapter)).resolves.toStrictEqual(before[0]);
        await expect(readFile(paths.gateway)).resolves.toStrictEqual(before[1]);
        await expect(readFile(sentinel, "utf8")).resolves.toBe("retain bytes");
        await expect(live.discover(["local"], false)).resolves.toMatchObject({
          outcome: { tag: "ok", value: { peers: [{ peer }] } },
        });
        await resetLocal(agent);
        expect(existsSync(paths.adapter)).toBe(false);
        await expect(readFile(sentinel, "utf8")).resolves.toBe("retain bytes");
      } finally {
        live.close();
        await nativeUntil(async () => !existsSync(setup.socketPath));
      }
    },
  );
  test.each(["adapter", "gateway", "pairing"] as const)(
    "externally changed %s refuses repair before consent/acquisition",
    async (field) => {
      const agent = join(fixture.root, "agent");
      const selected = localPlan(defaultChoices("Repair"), setupPaths(agent).socket);
      await applyLocal(
        agent,
        selected,
        { acquire: async () => fixture.executable },
        () => undefined,
      );
      await damage(fixture.executable, "missing", join(fixture.root, "marker"));
      const paths = setupPaths(agent);
      const path = {
        adapter: paths.adapter,
        gateway: paths.gateway,
        pairing: join(paths.directory, "pairing.json"),
      }[field];
      const external = await changedProjection(path);
      const acquire = vi.fn<SetupBackend["acquire"]>(async () => builtGateway);
      const ui = dialog(["APPLY"]);
      await expect(
        setupCommand(agent, ui, vi.fn<ActivatePlan>(), {
          backend: { acquire },
          description: "TEST",
        }),
      ).rejects.toThrow("configuration changed");
      expect(acquire).not.toHaveBeenCalled();
      expect(ui.ui.select).not.toHaveBeenCalled();
      await expect(readFile(path, "utf8")).resolves.toBe(external);
    },
  );
  test("without a trusted production pin, reviewed repair stays explicitly blocked", async () => {
    const agent = join(fixture.root, "agent");
    const selected = localPlan(defaultChoices("Repair"), setupPaths(agent).socket);
    await applyLocal(agent, selected, { acquire: async () => fixture.executable }, () => undefined);
    await damage(fixture.executable, "missing", join(fixture.root, "marker"));
    const paths = setupPaths(agent);
    const before = await readFile(paths.metadata);
    const ui = dialog(["APPLY"]);
    await setupCommand(agent, ui, vi.fn<ActivatePlan>());
    expect(ui.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Repair blocked"), "warning");
    await expect(readFile(paths.metadata)).resolves.toStrictEqual(before);
    expect(existsSync(join(paths.directory, "repair.json"))).toBe(false);
  });
  test("interrupted metadata-first repair resumes its verified ledger without reacquiring or changing config", async () => {
    const agent = join(fixture.root, "agent");
    const selected = localPlan(defaultChoices("Repair"), setupPaths(agent).socket);
    await applyLocal(agent, selected, { acquire: async () => fixture.executable }, () => undefined);
    const paths = setupPaths(agent);
    const metadata = await readFile(paths.metadata);
    const installed = await readFile(paths.installed);
    const adapter = await readFile(paths.adapter);
    const record = decodeManaged(parseJson(metadata));
    const replacement = join(fixture.root, "new-native");
    await copyFile(builtGateway, replacement);
    await chmod(replacement, 0o500);
    const sha256 = await executableDigest(replacement);
    const nextManaged = { ...record, executable: replacement, executableSha256: sha256 };
    await writeFile(
      join(paths.directory, "repair.json"),
      JSON.stringify({
        version: 1,
        beforeMetadataSha256: digest(metadata),
        beforeInstalledSha256: digest(installed),
        nextManaged,
        nextInstalled: { executable: replacement, sha256 },
      }),
      { mode: 0o600 },
    );
    await writeFile(paths.metadata, `${JSON.stringify(nextManaged, null, 2)}\n`);
    await damage(fixture.executable, "missing", join(fixture.root, "marker"));
    const acquire = vi.fn<SetupBackend["acquire"]>(async () => builtGateway);
    await setupCommand(agent, dialog(["APPLY"]), vi.fn<ActivatePlan>(), {
      backend: { acquire },
      description: "TEST",
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(existsSync(join(paths.directory, "repair.json"))).toBe(false);
    await expect(readFile(paths.adapter)).resolves.toStrictEqual(adapter);
    const repaired = await readManaged(agent, selected.adapter);
    expect(repaired?.executable).toBe(replacement);
    await resetLocal(agent);
    expect(existsSync(paths.adapter)).toBe(false);
  });
});

async function changedProjection(path: string): Promise<string> {
  let original: string;
  try {
    original = await readFile(path, "utf8");
  } catch (error) {
    if (
      !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
    original = "{}";
  }
  const external = `${original}\n`;
  await writeFile(path, external);
  return external;
}
