import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  lstat,
  copyFile,
  chmod,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GatewayClient } from "../adapter/client.js";
import { loadConfiguration } from "../adapter/config.js";
import { AdapterSession } from "../adapter/session.js";
import { registerTools } from "../adapter/tools.js";
import { ConnectionFailure, freshId } from "../adapter/transport.js";
import type { SetupBackend } from "../onboarding/backend.js";
import {
  applyLocal,
  inspectSetup,
  readManaged,
  reloadManagedLauncher,
  resetLocal,
  setupPaths,
} from "../onboarding/backend.js";
import type { DialogContext } from "../onboarding/dialog.js";
import { managedLauncher } from "../onboarding/managed.js";
import type { LocalPlan } from "../onboarding/plan.js";
import { defaultChoices, localPlan } from "../onboarding/plan.js";
import { setupCommand } from "../onboarding/setup.js";
import { saveOwnedPlan } from "../onboarding/update.js";
import type { ActivatePlan } from "../onboarding/upgrade.js";

const builtExecutable = resolve("packages/pi-comms/gateway/target/debug/pi-gateway");
let executable: string;
let root: string;
let agent: string;

function backend() {
  return { acquire: vi.fn<SetupBackend["acquire"]>(async () => executable) };
}
function plan() {
  return localPlan(defaultChoices("Native Host"), setupPaths(agent).socket);
}
function ui(answers: (string | undefined)[], mode: DialogContext["mode"] = "rpc"): DialogContext {
  const select = vi.fn<DialogContext["ui"]["select"]>(async (_title: string, options: string[]) => {
    const answer = answers.shift();
    return answer === "APPLY" ? options.find((item) => item.startsWith("Apply —")) : answer;
  });
  return {
    mode,
    signal: undefined,
    hasUI: mode === "rpc" || mode === "tui",
    ui: {
      select,
      input: vi.fn<DialogContext["ui"]["input"]>(),
      notify: vi.fn<DialogContext["ui"]["notify"]>(),
    },
  };
}
async function until(check: () => Promise<boolean>, milliseconds = 5000) {
  const deadline = performance.now() + milliseconds;
  while (!(await check())) {
    if (performance.now() >= deadline) {
      throw new Error("Native condition deadline exceeded");
    }
    await delay(25);
  }
}
function client(
  config: NonNullable<Awaited<ReturnType<typeof loadConfiguration>>>,
  ensureGateway: ReturnType<typeof managedLauncher>,
) {
  return new GatewayClient({
    config,
    peer: {
      machineId: config.machineId,
      sessionId: freshId(),
      runtimeNonce: freshId(),
    },
    incoming: () => {
      throw new Error("No unsolicited request expected");
    },
    statusChanged: () => undefined,
    ensureGateway,
  });
}
describe("actual setup plan/apply lifecycle", () => {
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "pc-")));
    agent = join(root, "agent");
    executable = join(root, "pi-gateway");
    await copyFile(builtExecutable, executable);
    await chmod(executable, 0o500);
    vi.stubEnv("HOME", root);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  test("cancel and forged attended RPC selection leave no directories, acquisition or runtime", async () => {
    for (const answer of [undefined, "forged-option"]) {
      const injected = backend();
      const activate = vi.fn<ActivatePlan>();
      await setupCommand(agent, ui([answer]), activate, {
        backend: injected,
        description: "Test backend: validated native binary",
      });
      expect(injected.acquire).not.toHaveBeenCalled();
      expect(activate).not.toHaveBeenCalled();
      expect(existsSync(agent)).toBe(false);
    }
  });
  test("final review cancellation and print/JSON refuse effects", async () => {
    const injected = backend();
    await setupCommand(
      agent,
      ui(["Local only — no remote connections (recommended)", "Cancel — no changes"]),
      vi.fn<ActivatePlan>(),
      { backend: injected, description: "Test backend" },
    );
    expect(existsSync(agent)).toBe(false);
    for (const mode of ["print", "json"] as const) {
      await expect(setupCommand(agent, ui([], mode), vi.fn())).rejects.toThrow("attended RPC");
    }
    expect(injected.acquire).not.toHaveBeenCalled();
  });
  test("custom and dangling symlink configurations are preserved", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(agent);
    const path = setupPaths(agent).adapter;
    await symlink(join(root, "missing"), path);
    const injected = backend();
    await setupCommand(agent, ui([]), vi.fn<ActivatePlan>(), {
      backend: injected,
      description: "Test",
    });
    await expect(isLink(path)).resolves.toBe(true);
    expect(injected.acquire).not.toHaveBeenCalled();
  });
  test("apply validates real native version, private projections and metadata; reset archives without credential deletion; reinstall reuses verified executable", async () => {
    expect(existsSync(executable), "Build the real native gateway before onboarding tests").toBe(
      true,
    );
    const injected = backend();
    const selected = plan();
    const setup = await applyLocal(agent, selected, injected, () => undefined);
    await expect(readManaged(agent, selected.adapter)).resolves.toStrictEqual(setup);
    await expect(fileMode(setupPaths(agent).adapter)).resolves.toBe(0o600);
    await expect(fileMode(join(setup.socketPath, ".."))).resolves.toBe(0o700);
    const sentinel = join(setupPaths(agent).directory, "revocation-floor.json");
    await writeFile(sentinel, "never delete");
    await resetLocal(agent);
    await expect(loadConfiguration(agent)).resolves.toBeUndefined();
    await expect(readFile(sentinel, "utf8")).resolves.toBe("never delete");
    await expect(hasBackup(agent)).resolves.toBe(true);
    await applyLocal(agent, selected, injected, () => undefined);
    expect(injected.acquire).toHaveBeenCalledTimes(1);
  });
  test("concurrent custom config wins create-only CAS, and externally changed setup is not reset", async () => {
    const selected = plan();
    const injected = backend();
    injected.acquire.mockImplementation(async () => {
      await writeFile(setupPaths(agent).adapter, "external");
      return executable;
    });
    await expect(applyLocal(agent, selected, injected, () => undefined)).rejects.toThrow(
      "Setup state changed",
    );
    await expect(readFile(setupPaths(agent).adapter, "utf8")).resolves.toBe("external");
    await expect(resetLocal(agent)).rejects.toThrow("No verified setup executable");
    await expect(pendingSetup(agent)).resolves.toBe(false);
  });
  test("interrupted acquisition is explicitly recoverable and does not enable participation", async () => {
    await expect(
      applyLocal(
        agent,
        plan(),
        {
          acquire: async () => {
            throw new Error("offline");
          },
        },
        () => undefined,
      ),
    ).rejects.toThrow("offline");
    await expect(loadConfiguration(agent)).resolves.toBeUndefined();
    await expect(pendingSetup(agent)).resolves.toBe(false);
    await expect(resetLocal(agent)).rejects.toThrow("No verified setup executable");
    await expect(pendingSetup(agent)).resolves.toBe(false);
    await applyLocal(agent, plan(), backend(), () => undefined);
  });
  test("two native participants share detached singleton; first close retains gateway, last close exits", async () => {
    const selected = plan();
    const setup = await applyLocal(agent, selected, backend(), () => undefined);
    const ensure = managedLauncher(setup);
    const first = client(selected.adapter, ensure);
    const second = client(selected.adapter, ensure);
    try {
      await Promise.all([first.reconnect(), second.reconnect()]);
      const roster = await first.discover(selected.adapter.scopeIds, false);
      expect(roster.outcome.tag).toBe("ok");
      first.close();
      await delay(900);
      expect(second.status().connected).toBe(true);
      second.close();
      await until(async () => !existsSync(setup.socketPath));
    } finally {
      first.close();
      second.close();
      await until(async () => !existsSync(setup.socketPath), 12_000);
    }
  });
  test("native gateway crash recovers with surviving clients and unchanged peer identities", async () => {
    const selected = plan();
    const setup = await applyLocal(agent, selected, backend(), () => undefined);
    const child = spawn(executable, ["--managed", "--config", setup.gatewayPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await once(child.stdout, "data");
    const ensure = managedLauncher(setup);
    const first = client(selected.adapter, ensure);
    const second = client(selected.adapter, ensure);
    try {
      await Promise.all([first.reconnect(), second.reconnect()]);
      const oldInode = await inode(setup.socketPath);
      child.kill("SIGKILL");
      await once(child, "exit");
      await until(
        async () => replacementConnected(setup.socketPath, oldInode, first, second),
        10_000,
      );
      const roster = await first.discover(selected.adapter.scopeIds, false);
      expect(roster.outcome.tag).toBe("ok");
    } finally {
      child.kill("SIGTERM");
      first.close();
      second.close();
      await until(async () => !existsSync(setup.socketPath), 12_000);
    }
  });
  test("gateway drift preflight refuses reset before disabling adapter", async () => {
    await applyLocal(agent, plan(), backend(), () => undefined);
    const paths = setupPaths(agent);
    const before = await readFile(paths.adapter);
    await writeFile(paths.gateway, "external gateway bytes");
    await expect(resetLocal(agent)).rejects.toThrow("Gateway config changed externally");
    await expect(readFile(paths.adapter)).resolves.toStrictEqual(before);
    expect(existsSync(join(paths.directory, "reset.json"))).toBe(false);
  });
  test("SIGKILL releases retained native lock and two recovery contenders serialize without replacing its inode", async () => {
    const { withSetupLock } = await import("../onboarding/files.js");
    await applyLocal(agent, plan(), backend(), () => undefined);
    const path = setupPaths(agent).lock;
    const holder = spawn(executable, ["--setup-lock", path], { stdio: ["pipe", "pipe", "pipe"] });
    await once(holder.stdout, "data");
    const lockInode = await inode(path);
    holder.kill("SIGKILL");
    await once(holder, "exit");
    const results = await Promise.allSettled([
      withSetupLock(path, executable, async () => {
        await delay(150);
        return true;
      }),
      withSetupLock(path, executable, async () => {
        await delay(150);
        return true;
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(inode(path)).resolves.toBe(lockInode);
  });
  test.each(["machineId", "scopeIds", "socketPath", "policies"] as const)(
    "surviving launcher refuses incompatible parsed %s without starting a gateway",
    async (field) => {
      const selected = plan();
      const setup = await applyLocal(agent, selected, backend(), () => undefined);
      const ensure = reloadManagedLauncher(agent, selected.adapter, setup);
      await saveOwnedPlan(agent, setup, incompatiblePlan(selected, field), undefined, true);
      await expect(ensure(Date.now() + 2000, new AbortController().signal)).rejects.toThrow(
        "explicit runtime replacement required",
      );
      expect(existsSync(setup.socketPath)).toBe(false);
    },
  );
  test("an exhausted managed episode stops; next production tool reconnects before effective-scope guards", async () => {
    const selected = plan();
    const setup = await applyLocal(agent, selected, backend(), () => undefined);
    const launcher = managedLauncher(setup);
    const gate = recoveryGate(launcher);
    const session = new AdapterSession(
      selected.adapter,
      { machineId: selected.adapter.machineId, sessionId: freshId(), runtimeNonce: freshId() },
      { sendMessage: () => undefined },
      () => undefined,
      () => undefined,
      gate.ensure,
    );
    const tools = new Map<string, () => Promise<unknown>>();
    registerTools(
      {
        registerTool: (definition) => {
          tools.set(definition.name, async () => {
            const value: unknown = Reflect.apply(definition.execute.bind(definition), undefined, [
              "fixture",
              {},
              undefined,
              undefined,
              undefined,
            ]);
            return value;
          });
        },
      },
      () => session,
    );
    try {
      await expect(session.reconnect()).rejects.toThrow("unavailable");
      expect(gate.attempts()).toBe(6);
      expect([...session.client.effectiveScopes()]).toStrictEqual([]);
      await delay(150);
      expect(gate.attempts()).toBe(6);
      gate.allow();
      await expect(tools.get("session_peers")?.()).resolves.toMatchObject({
        details: { value: { peers: [{ label: "Pi", peer: session.peer, scopeIds: ["local"] }] } },
      });
      expect([...session.client.effectiveScopes()]).toStrictEqual(["local"]);
    } finally {
      session.close();
      await until(async () => !existsSync(setup.socketPath), 12_000);
    }
  });
});

async function isLink(path: string) {
  const stat = await lstat(path);
  return stat.isSymbolicLink();
}
async function fileMode(path: string) {
  const stat = await lstat(path);
  return stat.mode & 0o777;
}
async function inode(path: string) {
  const stat = await lstat(path);
  return stat.ino;
}
async function pendingSetup(path: string) {
  const state = await inspectSetup(path);
  return state.pending;
}
async function hasBackup(path: string) {
  const files = await readdir(path);
  return files.some((name) => name.startsWith("session-communication.json.disabled-"));
}
async function replacementConnected(
  path: string,
  old: number,
  first: GatewayClient,
  second: GatewayClient,
) {
  return (
    existsSync(path) &&
    (await inode(path)) !== old &&
    first.status().connected &&
    second.status().connected
  );
}

function recoveryGate(launcher: ReturnType<typeof managedLauncher>) {
  let available = false;
  let count = 0;
  return {
    allow: () => {
      available = true;
    },
    attempts: () => count,
    ensure: async (deadline: number, signal: AbortSignal) => {
      count += 1;
      if (!available) {
        throw new ConnectionFailure("unavailable", false);
      }
      return launcher(deadline, signal);
    },
  };
}

function incompatiblePlan(
  selected: LocalPlan,
  field: "machineId" | "scopeIds" | "socketPath" | "policies",
): LocalPlan {
  const changes = {
    machineId: "different-host",
    scopeIds: ["different"],
    socketPath: join(root, "different.sock"),
    policies: selected.adapter.policies.map((grant) => ({
      ...grant,
      permissions: grant.permissions.filter((permission) => permission !== "push"),
    })),
  };
  return { ...selected, adapter: { ...selected.adapter, [field]: changes[field] } };
}
