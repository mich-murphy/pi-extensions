import { randomBytes } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { decodeConfiguration } from "../adapter/config.js";
import { executableDigest, setupPaths } from "./backend.js";
import type { SetupBackend } from "./backend.js";
import { GATEWAY_LOCAL_SETUP_CAPABILITIES, GATEWAY_REMOTE_SETUP_CAPABILITIES } from "./catalog.js";
import { reviewAction } from "./dialog.js";
import type { DialogContext } from "./dialog.js";
import { createPrivate, digest, durableUnlink, regularBytes, withSetupLock } from "./files.js";
import { validateExecutable } from "./managed.js";
import { replaceOwned } from "./owned-file.js";
import {
  cachedSchema,
  managedSchema,
  decodeCached,
  decodeManaged,
  decodeGateway,
  parseJson,
} from "./schema.js";

const decodeRepair = Schema.decodeUnknownSync(
  Schema.Struct({
    version: Schema.Literal(1),
    beforeMetadataSha256: managedSchema.fields.adapterSha256,
    beforeInstalledSha256: managedSchema.fields.adapterSha256,
    nextManaged: managedSchema,
    nextInstalled: cachedSchema,
  }),
  { onExcessProperty: "error" },
);
type Ledger = ReturnType<typeof decodeRepair>;
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Read-only ownership/projection inspection: never execute an unavailable old file. */
async function inspectOwned(agentDir: string) {
  const paths = setupPaths(agentDir);
  const metadata = await regularBytes(paths.metadata);
  if (metadata === undefined) {
    return undefined;
  }
  await ownedDirectory(paths.directory);
  const [installed, adapter, gateway, pairing, pending, prepared, reset, repair] =
    await Promise.all(
      [
        paths.installed,
        paths.adapter,
        paths.gateway,
        join(paths.directory, "pairing.json"),
        paths.journal,
        paths.prepared,
        join(paths.directory, "reset.json"),
        join(paths.directory, "repair.json"),
      ].map(async (path) => regularBytes(path)),
    );
  if (pending !== undefined || prepared !== undefined || reset !== undefined) {
    throw new Error(
      "Interrupted setup/reset preserved; installation repair will not migrate its ownership",
    );
  }
  if (installed === undefined || adapter === undefined || gateway === undefined) {
    throw new Error("Repair requires committed owned metadata and unchanged configuration");
  }
  const record = decodeManaged(parseJson(metadata));
  const cache = decodeCached(parseJson(installed));
  verifyProjections(paths, record, { adapter, gateway, pairing });
  const ledger = repair === undefined ? undefined : decodeRepair(parseJson(repair));
  if (ledger === undefined) {
    if (cache.executable !== record.executable || cache.sha256 !== record.executableSha256) {
      throw new Error("Installed/executable metadata disagree without a repair ledger; preserved");
    }
  } else {
    validateLedger(ledger, record, metadata, installed);
  }
  return {
    paths,
    metadata,
    installed,
    record,
    ledger,
    remote: decodeGateway(parseJson(gateway)).remote !== undefined || pairing !== undefined,
  };
}
async function ownedDirectory(path: string): Promise<void> {
  const directory = await lstat(path);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0 ||
    (await realpath(path)) !== path
  ) {
    throw new Error("Repair refuses unsafe ownership directory");
  }
}
function verifyProjections(
  paths: ReturnType<typeof setupPaths>,
  record: ReturnType<typeof decodeManaged>,
  { adapter, gateway, pairing }: { adapter: Buffer; gateway: Buffer; pairing: Buffer | undefined },
): void {
  const config = decodeConfiguration(parseJson(adapter));
  if (
    record.gatewayPath !== paths.gateway ||
    record.socketPath !== config.socketPath ||
    digest(adapter) !== record.adapterSha256 ||
    digest(gateway) !== record.gatewaySha256 ||
    (pairing === undefined ? undefined : digest(pairing)) !== record.pairingSha256
  ) {
    throw new Error("Owned configuration changed; installation repair refused");
  }
}
type Owned = NonNullable<Awaited<ReturnType<typeof inspectOwned>>>;
function validateLedger(
  ledger: Ledger,
  record: Owned["record"],
  metadata: Buffer,
  installed: Buffer,
): void {
  const same = [
    "version",
    "adapterSha256",
    "gatewaySha256",
    "pairingSha256",
    "gatewayPath",
    "socketPath",
  ] as const;
  if (
    !same.every((key) => ledger.nextManaged[key] === record[key]) ||
    ledger.nextManaged.executable !== ledger.nextInstalled.executable ||
    ledger.nextManaged.executableSha256 !== ledger.nextInstalled.sha256 ||
    ![ledger.beforeMetadataSha256, digest(json(ledger.nextManaged))].includes(digest(metadata)) ||
    ![ledger.beforeInstalledSha256, digest(json(ledger.nextInstalled))].includes(digest(installed))
  ) {
    throw new Error("Invalid repair recovery ledger; files preserved");
  }
}
async function healthy(owned: Owned): Promise<boolean> {
  try {
    if ((await executableDigest(owned.record.executable)) !== owned.record.executableSha256) {
      return false;
    }
    await validateExecutable(
      owned.record.executable,
      owned.remote ? GATEWAY_REMOTE_SETUP_CAPABILITIES : GATEWAY_LOCAL_SETUP_CAPABILITIES,
    );
    return true;
  } catch {
    return false;
  }
}

/** Missing, damaged or mandatory-capability-incompatible ownership needs explicit repair, not version updates. */
export async function repairInstallation(
  agentDir: string,
  ctx: DialogContext,
  acquisition: (remote: boolean) => Promise<{ backend?: SetupBackend; description: string }>,
  reconnect?: () => Promise<void>,
): Promise<boolean> {
  const owned = await inspectOwned(agentDir);
  if (owned === undefined || (owned.ledger === undefined && (await healthy(owned)))) {
    return false;
  }
  const route =
    owned.ledger === undefined
      ? await acquisition(owned.remote)
      : {
          description: `Resume already reviewed owned repair using ${owned.ledger.nextInstalled.executable}, rechecking its recorded SHA256.`,
          backend: { acquire: async () => owned.ledger?.nextInstalled.executable ?? "" },
        };
  const approved = await reviewAction(
    ctx,
    `Repair unavailable or mandatory-capability-incompatible setup-owned gateway installation only.\nPreserve adapter, gateway, keys, floors and THIS Pi nonce/state.\n${route.backend === undefined ? "Acquisition BLOCKED: no reviewed trusted pin." : "Apply: trusted reacquisition, verified lock, metadata CAS."}`,
    `${route.description}\nMissing, tampered or unsafe old file ${owned.record.executable} is NEVER executed. Only a hash-verified prior helper may receive a bounded read-only --version --json probe to check mandatory capabilities; repair never uses it for gateway, lock, pairing or control operations and never deletes it. Only ${owned.paths.metadata} and ${owned.paths.installed} change, under a verified NEW helper's native lock. Create-only repair-install-* acquisition staging, repair.json resumable ledger and .previous-* metadata backups may remain after interruption. Recheck unchanged configuration/pairing hashes before any metadata mutation. No configuration/key/floor rewrite, automatic version policy, runtime replacement or uncertain-send replay. Reconnect is bounded and control-free; an already-running older gateway may reject guarded registration until it exits. Passive /comms reconnect never retires it; /comms setup → Activate saved configuration offers a separate explicitly reviewed restart. Existing sessions may still use old trust until retirement.`,
    "Apply — repair owned installation only",
  );
  if (!approved) {
    ctx.ui.notify("Repair cancelled — no changes made", "info");
    return true;
  }
  if (route.backend === undefined) {
    ctx.ui.notify(`Repair blocked — ${route.description} No changes made.`, "warning");
    return true;
  }
  await applyRepair(agentDir, owned, route.backend, (message) => {
    ctx.ui.notify(message, "info");
  });
  try {
    await reconnect?.();
  } catch {
    ctx.ui.notify(
      "Installation repaired; guarded activation pending or unconfirmed. No runtime/state was replaced and no control request was sent. An older live gateway may reject guarded admission. Passive /comms reconnect never retires it; /comms setup → Activate saved configuration offers a separate explicitly reviewed restart. Existing sessions may still use old trust until retirement.",
      "warning",
    );
    return true;
  }
  ctx.ui.notify(
    "Installation repaired; owned metadata committed. No runtime/nonce/state was replaced and no control request was sent. Guarded local activation and remote readiness must be checked separately. If activation remains pending/unconfirmed, passive /comms reconnect never retires an older gateway; /comms setup → Activate saved configuration offers a separate explicitly reviewed restart. Existing sessions may still use old trust until retirement.",
    "info",
  );
  return true;
}
async function repairLedger(
  owned: Owned,
  backend: SetupBackend,
  progress: (message: string) => void,
): Promise<Ledger> {
  if (owned.ledger !== undefined) {
    return owned.ledger;
  }
  const executable = await backend.acquire(
    join(owned.paths.directory, `repair-install-${randomBytes(12).toString("hex")}`),
    progress,
  );
  const sha256 = await executableDigest(executable);
  return {
    version: 1,
    beforeMetadataSha256: digest(owned.metadata),
    beforeInstalledSha256: digest(owned.installed),
    nextManaged: { ...owned.record, executable, executableSha256: sha256 },
    nextInstalled: { executable, sha256 },
  };
}
async function applyRepair(
  agentDir: string,
  owned: Owned,
  backend: SetupBackend,
  progress: (message: string) => void,
): Promise<void> {
  const ledger = await repairLedger(owned, backend, progress);
  const executable = ledger.nextInstalled.executable;
  if ((await executableDigest(executable)) !== ledger.nextInstalled.sha256) {
    throw new Error("Repair candidate changed; never executed");
  }
  await validateExecutable(
    executable,
    owned.remote ? GATEWAY_REMOTE_SETUP_CAPABILITIES : GATEWAY_LOCAL_SETUP_CAPABILITIES,
  );
  await withSetupLock(owned.paths.lock, executable, async () => {
    const current = await inspectOwned(agentDir);
    if (
      current === undefined ||
      digest(current.metadata) !== digest(owned.metadata) ||
      digest(current.installed) !== digest(owned.installed)
    ) {
      throw new Error("Repair snapshots changed; acquired file retained, configuration preserved");
    }
    const journal = join(owned.paths.directory, "repair.json");
    if (owned.ledger === undefined) {
      await createPrivate(journal, json(ledger));
    }
    if (digest(current.metadata) !== digest(json(ledger.nextManaged))) {
      await replaceOwned(
        owned.paths.metadata,
        ledger.beforeMetadataSha256,
        json(ledger.nextManaged),
      );
    }
    if (digest(current.installed) !== digest(json(ledger.nextInstalled))) {
      await replaceOwned(
        owned.paths.installed,
        ledger.beforeInstalledSha256,
        json(ledger.nextInstalled),
      );
    }
    await durableUnlink(journal);
  });
}
