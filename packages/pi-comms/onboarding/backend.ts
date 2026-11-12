import { createHash, randomBytes } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { loadConfiguration } from "../adapter/config.js";
import type { Configuration } from "../adapter/config.js";
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
import { decodeManaged, decodeCached, decodeOwnership, decodeReset, parseJson } from "./schema.js";

export type SetupBackend = {
  acquire: (directory: string, progress: (message: string) => void) => Promise<string>;
};
export function setupPaths(agentDir: string) {
  let canonicalAgent = resolve(agentDir);
  try {
    canonicalAgent = realpathSync(canonicalAgent);
  } catch {
    /* New profile is not created by inspection. */
  }
  const directory = join(canonicalAgent, "comms");
  const id = digest(directory).slice(0, 16);
  return {
    directory,
    adapter: join(resolve(agentDir), "session-communication.json"),
    metadata: join(directory, "setup.json"),
    gateway: join(directory, "gateway.json"),
    journal: join(directory, "pending.json"),
    prepared: join(directory, "prepared.json"),
    installed: join(directory, "installed.json"),
    lock: join(directory, "apply.lock"),
    socket: join(realpathSync(homedir()), ".pi", "comms", id, "s"),
  };
}
export async function executableDigest(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BINARY || (stat.mode & 0o111) === 0) {
      throw new Error("Expected bounded regular executable; explicit installation repair required");
    }
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      if (!Buffer.isBuffer(chunk)) {
        throw new TypeError("Expected executable bytes");
      }
      size += chunk.length;
      if (size > MAX_BINARY) {
        throw new Error("Executable grew beyond size bound");
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
    throw new Error("Invalid setup ownership metadata");
  }
  const adapter = await regularBytes(paths.adapter);
  if (adapter === undefined || digest(adapter) !== value.adapterSha256) {
    throw new Error("Setup config was changed externally; automatic startup refused");
  }
  if ((await executableDigest(value.executable)) !== value.executableSha256) {
    throw new Error("Setup executable changed; automatic startup refused");
  }
  return value;
}
export async function inspectSetup(agentDir: string, socketPath?: string) {
  const paths = setupPaths(agentDir);
  // lstat distinguishes dangling links from absent files. Never adopt external configuration.
  let existing = false;
  try {
    await lstat(paths.adapter);
    existing = true;
  } catch (error) {
    if (
      !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
  let sharedInstance = false;
  try {
    const socket = await lstat(socketPath ?? paths.socket);
    sharedInstance = socket.isSocket();
  } catch (error) {
    if (
      !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
    ) {
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
/** Create-only journal precedes effects. Interrupted artifacts are preserved for explicit reset. */
export async function applyLocal(
  agentDir: string,
  plan: LocalPlan,
  backend: SetupBackend,
  progress: (message: string) => void,
  prepare?: (executable: string, plan: LocalPlan) => Promise<LocalPlan>,
): Promise<ManagedSetup> {
  const paths = setupPaths(agentDir);
  // Bootstrap acquisition is per-attempt and precedes the shared mutation journal.
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
      throw new Error("Setup cache/state changed during acquisition; nothing overwritten");
    }
    if ((await executableDigest(executable)) !== acquiredDigest) {
      throw new Error("Acquired executable changed; nothing overwritten");
    }
    const state = await inspectSetup(agentDir);
    if (
      state.existing ||
      state.pending ||
      (await regularBytes(join(paths.directory, "repair.json"))) !== undefined
    ) {
      throw new Error(
        "Setup state changed or an interrupted apply exists; run /comms doctor or reset. Nothing overwritten.",
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
    // Commit enablement last. O_EXCL is the compare-and-swap against absent configuration.
    await createPrivate(paths.adapter, adapter);
    await unlink(paths.journal);
    await unlink(paths.prepared);
    return metadata;
  });
}
export class ResetFailure extends Error {
  constructor(readonly disabled: boolean) {
    super(
      disabled
        ? "Reset partially completed: participation is disabled on disk; retry /comms reset to finish owned archives. Credentials and floors retained."
        : "Reset refused before disabling participation; external files/runtime preserved.",
    );
  }
}
type ResetEntry = { path: string; backup: string; sha256: string };
/** Preflight every invariant before the first rename; durable ledger resumes partial archives. */
export async function resetLocal(agentDir: string): Promise<string> {
  const paths = setupPaths(agentDir);
  const executable = await cachedExecutable(paths);
  if (executable === undefined) {
    throw new Error(
      "No verified setup executable/committed ownership. Pre-acquisition remnants are not enabled and are preserved.",
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
      throw new ResetFailure(!(await regularBytes(paths.adapter)));
    }
    return (
      entries.find((entry) => entry.path === paths.adapter)?.backup ??
      "Participation already disabled; owned partial artifacts archived. Credentials/floors retained."
    );
  });
}
type SetupPaths = ReturnType<typeof setupPaths>;
function resetPaths(paths: SetupPaths): string[] {
  return [
    paths.adapter,
    paths.gateway,
    paths.metadata,
    paths.prepared,
    paths.journal,
    join(paths.directory, "pairing.json"),
  ];
}
async function resetEntries(paths: SetupPaths): Promise<ResetEntry[]> {
  const path = join(paths.directory, "reset.json");
  const interrupted = await regularBytes(path);
  if (interrupted !== undefined) {
    const entries = [...decodeReset(parseJson(interrupted))];
    const allowed = new Set(resetPaths(paths));
    if (
      entries.some(
        (entry) => !allowed.has(entry.path) || !entry.backup.startsWith(`${entry.path}.disabled-`),
      )
    ) {
      throw new Error("Invalid reset recovery ledger; preserved");
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
  allowed: (string | undefined)[],
  label: string,
): void {
  if (bytes !== undefined && !allowed.includes(digest(bytes))) {
    throw new Error(`${label} changed externally; reset refused before mutation`);
  }
}
async function preflightReset(paths: SetupPaths): Promise<void> {
  if ((await regularBytes(join(paths.directory, "repair.json"))) !== undefined) {
    throw new Error(
      "Finish the owned installation repair with /comms setup before reset; repair ledger preserved",
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
    throw new Error("No setup ownership record; external files preserved");
  }
  const record = decodeOwnership(parseJson(recordBytes));
  const transition = pending === undefined ? undefined : decodeOwnership(parseJson(pending));
  matchReset(
    adapter,
    [record.adapterSha256, transition?.adapterSha256, transition?.previousAdapterSha256],
    "Configuration",
  );
  matchReset(
    gateway,
    [record.gatewaySha256, transition?.gatewaySha256, transition?.previousGatewaySha256],
    "Gateway config",
  );
  matchReset(pairing, [record.pairingSha256, transition?.pairingSha256], "Pairing metadata");
}
async function validateResetEntries(paths: SetupPaths, entries: ResetEntry[]): Promise<void> {
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
    throw new ResetFailure(!(await regularBytes(paths.adapter)));
  }
}
async function archiveResetEntry(entry: ResetEntry): Promise<void> {
  if ((await regularBytes(entry.path)) !== undefined) {
    await rename(entry.path, entry.backup);
  }
}

export async function reusableExecutable(
  agentDir: string,
  requiredCapabilities: readonly string[] = GATEWAY_LOCAL_SETUP_CAPABILITIES,
): Promise<string | undefined> {
  const cached = await regularBytes(setupPaths(agentDir).installed);
  if (cached === undefined) {
    return undefined;
  }
  const installed = decodeCached(parseJson(cached));
  if (!isAbsolute(installed.executable)) {
    throw new Error("Invalid cached executable path; preserved");
  }
  try {
    if ((await executableDigest(installed.executable)) !== installed.sha256) {
      throw new Error("Cached setup executable changed");
    }
    await validateExecutable(installed.executable, requiredCapabilities);
  } catch (error) {
    // A strictly decoded orphan descriptor is not committed installation ownership.
    // Hash-invalid targets are never executed; only byte-verified prior helpers receive
    // the bounded version probe. Unsupported or unavailable orphans can review fresh acquisition.
    if ((await regularBytes(setupPaths(agentDir).metadata)) !== undefined) {
      throw error;
    }
    return undefined;
  }
  return installed.executable;
}
/** Exact descriptor and projection snapshot, plus old target identity/bytes when safely readable. */
async function bootstrapSnapshot(paths: SetupPaths, requiredCapabilities: readonly string[]) {
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
    throw new Error(
      "Setup state changed: committed or interrupted projections preserved; bootstrap refused",
    );
  }
  const installed = await regularBytes(paths.installed);
  if (installed === undefined) {
    return { installed: undefined, reusable: undefined, target: undefined };
  }
  const record = decodeCached(parseJson(installed));
  if (!isAbsolute(record.executable)) {
    throw new Error("Invalid cached executable path; preserved");
  }
  let target;
  try {
    const stat = await lstat(record.executable, { bigint: true });
    let sha256;
    try {
      sha256 = await executableDigest(record.executable);
    } catch {
      // Unsafe types/oversized targets are never opened for execution or adopted.
    }
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
    if (
      !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
    ) {
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
/** Called only after matching the recorded byte digest; never probe a damaged cached target. */
async function supportsCapabilities(
  executable: string,
  requiredCapabilities: readonly string[],
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
  requiredCapabilities: readonly string[],
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
        "Managed adapter identity/config changed; explicit runtime replacement required",
      );
    }
    return current;
  });
}
