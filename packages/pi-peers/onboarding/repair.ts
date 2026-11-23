import { randomBytes } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { decodeConfiguration } from "../adapter/config.js";
import { executableDigest, setupPaths } from "./backend.js";
import type { SetupBackend } from "./backend.js";
import { GATEWAY_LOCAL_SETUP_CAPABILITIES, GATEWAY_REMOTE_SETUP_CAPABILITIES } from "./catalog.js";
import { createPrivate, digest, durableUnlink, regularBytes, withSetupLock } from "./files.js";
import { validateExecutable } from "./managed.js";
import { actionForm, BLOCKED_HELP, withTechnical } from "./menu/forms.js";
import type { Progress } from "./menu/forms.js";
import type { Screen } from "./menu/model.js";
import type { Outcome, Step } from "./menu/progress.js";
import { failedWith, INCOMPLETE_NEXT, pendingOutcome, SAVED_NEXT } from "./outcome.js";
import { replaceOwned } from "./owned-file.js";
import { Refusal, SETTINGS_CHANGED } from "./refusal.js";
import type { Acquisition, Reconnect } from "./route.js";
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
    throw new Refusal(
      "a previous setup or reset did not finish",
      "Choose Reset in /peers, then Setup again",
    );
  }
  if (installed === undefined || adapter === undefined || gateway === undefined) {
    throw new Refusal(
      "setup files are missing or were edited by hand",
      "Choose Reset in /peers, then Setup again",
    );
  }
  const record = decodeManaged(parseJson(metadata));
  const cache = decodeCached(parseJson(installed));
  verifyProjections(paths, record, { adapter, gateway, pairing });
  const ledger = repair === undefined ? undefined : decodeRepair(parseJson(repair));
  if (ledger === undefined) {
    if (cache.executable !== record.executable || cache.sha256 !== record.executableSha256) {
      throw new Error("The setup records disagree about the gateway program; files were kept");
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
    throw new Error("The pi-peers folder is not private to you, so repair stopped");
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
    throw new Error("The setup files were edited by hand, so repair stopped");
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
    throw new Error("The saved repair record is invalid; files were kept");
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

const STEPS = [
  "Getting the verified gateway",
  "Updating the install record",
  "Reconnecting this Pi",
] as const;

const REPAIR_TECHNICAL = (owned: Owned): string =>
  `Missing, tampered or unsafe old file ${owned.record.executable} is NEVER executed. Only a hash-verified prior helper may receive a bounded read-only --version --json probe to check mandatory capabilities; repair never uses it for gateway, lock, pairing or control operations and never deletes it. Only ${owned.paths.metadata} and ${owned.paths.installed} change, under a verified NEW helper's native lock. Create-only repair-install-* acquisition staging, repair.json resumable ledger and .previous-* metadata backups may remain after interruption. Recheck unchanged configuration/pairing hashes before any metadata mutation. No configuration/key/revocation record rewrite, automatic version policy, runtime replacement or uncertain-send replay. Reconnect is bounded and control-free; an already-running older gateway may reject guarded registration until it exits.`;

async function repairWork(
  agentDir: string,
  owned: Owned,
  backend: SetupBackend,
  reconnect: Reconnect | undefined,
  step: Step,
): Promise<Outcome> {
  step(STEPS[0]);
  try {
    await applyRepair(agentDir, owned, backend, (message) => {
      step(message.startsWith("Acquiring") ? STEPS[0] : STEPS[1]);
    });
  } catch (error) {
    return failedWith("Repair failed", error, INCOMPLETE_NEXT);
  }
  step(STEPS[2]);
  try {
    await reconnect?.();
  } catch {
    return pendingOutcome("Installation repaired", SAVED_NEXT, [
      "The gateway did not accept this Pi yet.",
    ]);
  }
  return {
    ok: true,
    headline: "✓ Installation repaired",
    facts: [],
    next: "Your settings, keys and this session were kept. Choose Status to check the connection.",
    technical: [
      "Owned metadata committed. No runtime/nonce/state was replaced and no control request was sent. Remote readiness must be checked separately.",
    ],
  };
}

export type RepairRoute = {
  readonly blocked: boolean;
  readonly screen: (progress: Progress) => Screen;
};

export async function repairRoute(
  agentDir: string,
  acquisition: (remote: boolean) => Promise<Acquisition>,
  reconnect?: Reconnect,
): Promise<RepairRoute | undefined> {
  const owned = await inspectOwned(agentDir);
  if (owned === undefined || (owned.ledger === undefined && (await healthy(owned)))) {
    return undefined;
  }
  const route: Acquisition =
    owned.ledger === undefined
      ? await acquisition(owned.remote)
      : {
          description: `Resume already reviewed owned repair using ${owned.ledger.nextInstalled.executable}, rechecking its recorded SHA256.`,
          backend: { acquire: async () => owned.ledger?.nextInstalled.executable ?? "" },
        };
  const { backend } = route;
  return {
    blocked: backend === undefined,
    screen: (progress) =>
      actionForm({
        title: "Setup",
        note: "The gateway program setup installed is missing, changed or too old. Repair replaces only that program; your settings, keys and this session are kept.",
        details: () =>
          withTechnical(
            [
              "Repair downloads a verified gateway and records it as this setup's program.",
              "Settings, keys, revocation records and this session are kept. Nothing is restarted.",
            ],
            [route.description, REPAIR_TECHNICAL(owned)],
          ),
        detailsDescription: "What repair downloads, changes and keeps.",
        consent: () => ({
          label: "Repair installation",
          action: "Repair",
          gate:
            backend === undefined
              ? { kind: "blocked", reason: "no verified gateway download" }
              : { kind: "ready", value: backend },
          description: "Replace only the gateway program, then reconnect this Pi.",
          blockedHelp: BLOCKED_HELP,
          run: (chosen) => {
            progress("Repairing", STEPS, async (step) =>
              repairWork(agentDir, owned, chosen, reconnect, step),
            );
          },
        }),
      }),
  };
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
    throw new Error("The new gateway program changed before it ran; it was not run");
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
      throw SETTINGS_CHANGED();
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
