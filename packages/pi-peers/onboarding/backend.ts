import { createHash, randomBytes } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { errnoCode } from "../../shared/errno.js";
import { loadConfiguration } from "../adapter/config.js";
import type { Configuration } from "../adapter/config.js";
import { stateLocations } from "../adapter/locations.js";
import { MAX_BINARY } from "./artifact.js";
import {
  GATEWAY_LOCAL_SETUP_CAPABILITIES,
  GATEWAY_LOCK_CAPABILITIES,
  GATEWAY_REMOTE_SETUP_CAPABILITIES,
} from "./catalog.js";
import {
  createPrivate,
  durableRename as rename,
  durableUnlink as unlink,
  digest,
  privateDirectory,
  regularBytes,
  withSetupLock,
} from "./files.js";
import type { ManagedSetup } from "./managed.js";
import { validateExecutable, managedLauncher } from "./managed.js";
import { replaceOwned } from "./owned-file.js";
import { defaultChoices } from "./plan.js";
import type { LocalPlan } from "./plan.js";
import { RefusalError } from "./refusal.js";
import { decodeManaged, decodeCached, decodeOwnership, decodeReset, parseJson } from "./schema.js";

export type SetupBackend = {
  acquire: (directory: string, progress: (message: string) => void) => Promise<string>;
};

export function setupPaths(agentDir: string) {
  const { active } = stateLocations(agentDir);
  const directory = active.directory;

  return {
    directory,
    adapter: active.config,
    metadata: join(directory, "setup.json"),
    gateway: join(directory, "gateway.json"),
    journal: join(directory, "pending.json"),
    prepared: join(directory, "prepared.json"),
    installed: join(directory, "installed.json"),
    lock: join(directory, "apply.lock"),
    socket: join(realpathSync(homedir()), ".pi", active.socketRoot, active.id, "s"),
  };
}

async function digestUnlessUnsafeToOpen(path: string): Promise<string | undefined> {
  try {
    return await executableDigest(path);
  } catch {
    return undefined;
  }
}

export async function executableDigest(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const stat = await file.stat();

    if (!stat.isFile() || stat.size > MAX_BINARY || (stat.mode & 0o111) === 0) {
      throw new Error("The gateway program is not a normal program file; repair the installation");
    }

    const hash = createHash("sha256");
    let size = 0;

    for await (const chunk of file.createReadStream({ autoClose: false })) {
      if (!Buffer.isBuffer(chunk)) {
        throw new TypeError("Expected executable bytes");
      }

      size += chunk.length;

      if (size > MAX_BINARY) {
        throw new Error("The gateway program grew while it was checked");
      }

      hash.update(chunk);
    }

    return hash.digest("hex");
  } finally {
    await file.close();
  }
}

export async function readManaged(
  agentDir: string,
  config: Configuration,
): Promise<ManagedSetup | undefined> {
  const paths = setupPaths(agentDir);
  const bytes = await regularBytes(paths.metadata);

  if (bytes === undefined) {
    return undefined;
  }

  const value = decodeManaged(parseJson(bytes));

  if (
    value.version !== 1 ||
    value.gatewayPath !== paths.gateway ||
    value.socketPath !== config.socketPath ||
    !isAbsolute(value.executable)
  ) {
    throw new Error("The saved setup record is invalid");
  }

  const adapter = await regularBytes(paths.adapter);

  if (adapter === undefined || digest(adapter) !== value.adapterSha256) {
    throw new Error("pi-peers.json no longer matches the setup record");
  }

  if ((await executableDigest(value.executable)) !== value.executableSha256) {
    throw new Error("The gateway program no longer matches the setup record");
  }

  return value;
}

export async function inspectSetup(agentDir: string, socketPath?: string) {
  const paths = setupPaths(agentDir);
  let existing = false;

  try {
    await lstat(paths.adapter);
    existing = true;
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") {
      throw error;
    }
  }

  let sharedInstance = false;

  try {
    const socket = await lstat(socketPath ?? paths.socket);
    sharedInstance = socket.isSocket();
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") {
      throw error;
    }
  }

  const pending = await regularBytes(paths.journal);

  return {
    paths,
    existing,
    sharedInstance,
    pending: pending !== undefined,
    choices: defaultChoices(hostname()),
    platform: `${process.platform}/${process.arch}`,
  };
}

export async function applyLocal(
  agentDir: string,
  plan: LocalPlan,
  backend: SetupBackend,
  progress: (message: string) => void,
  prepare?: (executable: string, plan: LocalPlan) => Promise<LocalPlan>,
): Promise<ManagedSetup> {
  const paths = setupPaths(agentDir);
  await privateDirectory(paths.directory);

  const requiredCapabilities =
    prepare !== undefined || plan.gateway.remote !== undefined
      ? GATEWAY_REMOTE_SETUP_CAPABILITIES
      : GATEWAY_LOCAL_SETUP_CAPABILITIES;

  const before = await bootstrapSnapshot(paths, requiredCapabilities);

  const executable = await setupExecutable(
    paths,
    backend,
    progress,
    before.reusable,
    requiredCapabilities,
  );

  const acquiredDigest = await executableDigest(executable);

  return withSetupLock(paths.lock, executable, async () => {
    if (
      JSON.stringify(await bootstrapSnapshot(paths, requiredCapabilities)) !==
      JSON.stringify(before)
    ) {
      throw new RefusalError("setup files changed during the download", "Try again");
    }

    if ((await executableDigest(executable)) !== acquiredDigest) {
      throw new RefusalError("the downloaded gateway changed before it was used", "Try again");
    }

    const state = await inspectSetup(agentDir);

    if (
      state.existing ||
      state.pending ||
      (await regularBytes(join(paths.directory, "repair.json"))) !== undefined
    ) {
      throw new RefusalError(
        "another setup or reset did not finish",
        "Choose Reset in /peers, then Setup again",
      );
    }

    const installed = JSON.stringify({ executable, sha256: acquiredDigest });

    if (before.installed === undefined) {
      await createPrivate(paths.installed, installed);
    } else if (!before.installed.equals(Buffer.from(installed)) && before.reusable === undefined) {
      await replaceOwned(paths.installed, digest(before.installed), installed);
    }

    let adapter = `${JSON.stringify(plan.adapter, null, 2)}\n`;
    let gateway = `${JSON.stringify(plan.gateway, null, 2)}\n`;
    await createPrivate(
      paths.journal,
      JSON.stringify({
        version: 1,
        adapterSha256: digest(adapter),
        gatewaySha256: digest(gateway),
      }),
    );
    progress("Applying reviewed private configuration and pairing effects");

    if (prepare !== undefined) {
      const prepared = await prepare(executable, plan);
      adapter = `${JSON.stringify(prepared.adapter, null, 2)}\n`;
      gateway = `${JSON.stringify(prepared.gateway, null, 2)}\n`;
    }

    const pairingBytes = await regularBytes(join(paths.directory, "pairing.json"));

    const pairingOwnership =
      pairingBytes === undefined ? {} : { pairingSha256: digest(pairingBytes) };

    await createPrivate(
      paths.prepared,
      JSON.stringify({
        adapterSha256: digest(adapter),
        gatewaySha256: digest(gateway),
        ...pairingOwnership,
      }),
    );

    if (plan.adapter.socketPath === paths.socket) {
      await privateDirectory(join(plan.adapter.socketPath, "..", ".."));
    }

    await privateDirectory(join(plan.adapter.socketPath, ".."));
    await createPrivate(paths.gateway, gateway);

    const metadata: ManagedSetup = {
      version: 1,
      executable,
      executableSha256: await executableDigest(executable),
      adapterSha256: digest(adapter),
      gatewaySha256: digest(gateway),
      ...pairingOwnership,
      gatewayPath: paths.gateway,
      socketPath: plan.adapter.socketPath,
    };

    await createPrivate(paths.metadata, `${JSON.stringify(metadata, null, 2)}\n`);
    await createPrivate(paths.adapter, adapter);
    await unlink(paths.journal);
    await unlink(paths.prepared);

    return metadata;
  });
}

export class ResetFailureError extends Error {
  constructor(readonly disabled: boolean) {
    super(disabled ? "Reset stopped after turning peers off" : "Reset stopped before any change");
  }
}

type ResetEntry = { path: string; backup: string; sha256: string };

export async function hasResetTarget(agentDir: string): Promise<boolean> {
  const paths = setupPaths(agentDir);

  const found = await Promise.all(
    [...resetPaths(paths), join(paths.directory, "reset.json")].map(async (path) => {
      try {
        await lstat(path);

        return true;
      } catch (error) {
        const code = errnoCode(error);

        if (code === "ENOENT" || code === "ENOTDIR") {
          return false;
        }

        throw error;
      }
    }),
  );

  return found.includes(true);
}

export async function resetLocal(agentDir: string): Promise<string> {
  const paths = setupPaths(agentDir);
  const executable = await cachedExecutable(paths);

  if (executable === undefined) {
    throw new RefusalError(
      "setup never finished, so peers is not on",
      "Choose Setup to start again",
    );
  }

  return withSetupLock(paths.lock, executable, async () => {
    const entries = await resetEntries(paths);
    await validateResetEntries(paths, entries);

    try {
      for (const entry of entries) {
        // eslint-disable-next-line eslint/no-await-in-loop -- Durable archives complete in ledger order, making interrupted reset resumable.
        await archiveResetEntry(entry);
      }

      await unlink(join(paths.directory, "reset.json"));
    } catch {
      throw new ResetFailureError(!(await regularBytes(paths.adapter)));
    }

    return (
      entries.find((entry) => entry.path === paths.adapter)?.backup ??
      "Peers was already off; leftover setup files were archived."
    );
  });
}

type SetupPaths = ReturnType<typeof setupPaths>;

function resetPaths(paths: SetupPaths): Array<string> {
  return [
    paths.adapter,
    paths.gateway,
    paths.metadata,
    paths.prepared,
    paths.journal,
    join(paths.directory, "pairing.json"),
  ];
}

async function resetEntries(paths: SetupPaths): Promise<Array<ResetEntry>> {
  const path = join(paths.directory, "reset.json");
  const interrupted = await regularBytes(path);

  if (interrupted !== undefined) {
    const damaged = new RefusalError(
      "the record of an earlier reset is damaged",
      `Move ${path} aside, then try again`,
    );

    let entries: Array<ResetEntry>;

    try {
      entries = [...decodeReset(parseJson(interrupted))];
    } catch {
      throw damaged;
    }

    const allowed = new Set(resetPaths(paths));

    if (
      entries.some(
        (entry) => !allowed.has(entry.path) || !entry.backup.startsWith(`${entry.path}.disabled-`),
      )
    ) {
      throw damaged;
    }

    return entries;
  }

  await preflightReset(paths);
  const suffix = `.disabled-${randomBytes(12).toString("hex")}`;

  const snapshots = await Promise.all(
    resetPaths(paths).map(async (source) => {
      const bytes = await regularBytes(source);

      return bytes === undefined
        ? []
        : [{ path: source, backup: source + suffix, sha256: digest(bytes) }];
    }),
  );

  const entries = snapshots.flat();
  await createPrivate(path, JSON.stringify(entries));

  return entries;
}

function matchReset(
  bytes: Buffer | undefined,
  allowed: Array<string | undefined>,
  label: string,
): void {
  if (bytes !== undefined && !allowed.includes(digest(bytes))) {
    throw new RefusalError(`${label} was edited by hand`, "Undo the edit, then try again");
  }
}

async function preflightReset(paths: SetupPaths): Promise<void> {
  if ((await regularBytes(join(paths.directory, "repair.json"))) !== undefined) {
    throw new RefusalError(
      "a gateway repair is unfinished",
      "Choose Setup to finish the repair first",
    );
  }

  const [metadata, prepared, pending, adapter, gateway, pairing] = await Promise.all(
    [
      paths.metadata,
      paths.prepared,
      paths.journal,
      paths.adapter,
      paths.gateway,
      join(paths.directory, "pairing.json"),
    ].map(async (path) => regularBytes(path)),
  );

  const recordBytes = metadata ?? prepared ?? pending;

  if (recordBytes === undefined) {
    throw new RefusalError(
      "pi-peers.json was written by hand",
      "Remove it by hand to turn peers off",
    );
  }

  const record = decodeOwnership(parseJson(recordBytes));
  const transition = pending === undefined ? undefined : decodeOwnership(parseJson(pending));
  matchReset(
    adapter,
    [record.adapterSha256, transition?.adapterSha256, transition?.previousAdapterSha256],
    "pi-peers.json",
  );
  matchReset(
    gateway,
    [record.gatewaySha256, transition?.gatewaySha256, transition?.previousGatewaySha256],
    "gateway.json",
  );
  matchReset(pairing, [record.pairingSha256, transition?.pairingSha256], "pairing.json");
}

async function validateResetEntries(paths: SetupPaths, entries: Array<ResetEntry>): Promise<void> {
  const valid = await Promise.all(
    entries.map(async (entry) => {
      const [source, backup] = await Promise.all([
        regularBytes(entry.path),
        regularBytes(entry.backup),
      ]);

      return source === undefined
        ? backup !== undefined && digest(backup) === entry.sha256
        : digest(source) === entry.sha256 && backup === undefined;
    }),
  );

  if (valid.includes(false)) {
    throw new ResetFailureError(!(await regularBytes(paths.adapter)));
  }
}

async function archiveResetEntry(entry: ResetEntry): Promise<void> {
  if ((await regularBytes(entry.path)) !== undefined) {
    await rename(entry.path, entry.backup);
  }
}

export async function reusableExecutable(
  agentDir: string,
  requiredCapabilities: ReadonlyArray<string> = GATEWAY_LOCAL_SETUP_CAPABILITIES,
): Promise<string | undefined> {
  const cached = await regularBytes(setupPaths(agentDir).installed);

  if (cached === undefined) {
    return undefined;
  }

  const installed = decodeCached(parseJson(cached));

  if (!isAbsolute(installed.executable)) {
    throw new Error("The saved gateway path is not absolute; it was kept");
  }

  try {
    if ((await executableDigest(installed.executable)) !== installed.sha256) {
      throw new Error("The saved gateway program changed since it was installed");
    }

    await validateExecutable(installed.executable, requiredCapabilities);
  } catch (error) {
    if ((await regularBytes(setupPaths(agentDir).metadata)) !== undefined) {
      throw error;
    }

    return undefined;
  }

  return installed.executable;
}

async function bootstrapSnapshot(paths: SetupPaths, requiredCapabilities: ReadonlyArray<string>) {
  const projections = await Promise.all(
    [
      paths.adapter,
      paths.metadata,
      paths.gateway,
      paths.journal,
      paths.prepared,
      join(paths.directory, "pairing.json"),
      join(paths.directory, "reset.json"),
      join(paths.directory, "repair.json"),
    ].map(async (path) => regularBytes(path)),
  );

  if (projections.some((bytes) => bytes !== undefined)) {
    throw new RefusalError(
      "peers is already set up or a setup did not finish",
      "Open /peers again to review the saved setup",
    );
  }

  const installed = await regularBytes(paths.installed);

  if (installed === undefined) {
    return { installed: undefined, reusable: undefined, target: undefined };
  }

  const record = decodeCached(parseJson(installed));

  if (!isAbsolute(record.executable)) {
    throw new Error("The saved gateway path is not absolute; it was kept");
  }

  let target;

  try {
    const stat = await lstat(record.executable, { bigint: true });
    const sha256 = await digestUnlessUnsafeToOpen(record.executable);
    target = {
      dev: String(stat.dev),
      ino: String(stat.ino),
      mode: String(stat.mode),
      size: String(stat.size),
      mtime: String(stat.mtimeNs),
      ctime: String(stat.ctimeNs),
      sha256,
    };
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") {
      throw error;
    }
  }

  return {
    installed,
    reusable:
      target?.sha256 === record.sha256 &&
      (await supportsCapabilities(record.executable, requiredCapabilities))
        ? record.executable
        : undefined,
    target,
  };
}

async function supportsCapabilities(
  executable: string,
  requiredCapabilities: ReadonlyArray<string>,
): Promise<boolean> {
  try {
    await validateExecutable(executable, requiredCapabilities);

    return true;
  } catch {
    return false;
  }
}

async function cachedExecutable(paths: ReturnType<typeof setupPaths>): Promise<string | undefined> {
  return reusableExecutable(join(paths.directory, ".."), GATEWAY_LOCK_CAPABILITIES);
}

async function setupExecutable(
  paths: ReturnType<typeof setupPaths>,
  backend: SetupBackend,
  progress: (message: string) => void,
  cached: string | undefined,
  requiredCapabilities: ReadonlyArray<string>,
): Promise<string> {
  if (cached !== undefined) {
    await validateExecutable(cached, requiredCapabilities);

    return cached;
  }

  progress(
    "Acquiring verified gateway before shared application journal (Nix build may take minutes)",
  );

  const executable = await backend.acquire(
    join(paths.directory, `install-${randomBytes(12).toString("hex")}`),
    progress,
  );

  await validateExecutable(executable, requiredCapabilities);

  return executable;
}

export function reloadManagedLauncher(
  agentDir: string,
  config: Configuration,
  setup: ManagedSetup,
) {
  return managedLauncher(setup, async () => {
    const current = await readManaged(agentDir, config);
    const nextConfig = await loadConfiguration(agentDir);

    if (
      current === undefined ||
      nextConfig === undefined ||
      nextConfig.machineId !== config.machineId ||
      nextConfig.socketPath !== config.socketPath ||
      JSON.stringify(nextConfig.scopeIds) !== JSON.stringify(config.scopeIds) ||
      !config.policies.every((old) =>
        nextConfig.policies.some(
          (grant) =>
            grant.machineId === old.machineId &&
            grant.scopeId === old.scopeId &&
            old.permissions.every((permission) => grant.permissions.includes(permission)),
        ),
      ) ||
      current.socketPath !== setup.socketPath
    ) {
      throw new Error(
        "Peers settings changed after this Pi connected. Start a new Pi session to use the saved settings.",
      );
    }

    return current;
  });
}
