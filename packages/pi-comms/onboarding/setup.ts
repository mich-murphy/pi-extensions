import { randomBytes } from "node:crypto";
import { isAbsolute, normalize, join } from "node:path";
import { loadConfiguration } from "../adapter/config.js";
import type { AcquisitionPlan } from "./acquire.js";
import { acquireGateway, discoverNixExecutable } from "./acquire.js";
import {
  applyLocal,
  inspectSetup,
  resetLocal,
  ResetFailure,
  reusableExecutable,
} from "./backend.js";
import type { SetupBackend } from "./backend.js";
import type { GatewayCatalog, GatewayNixPin, GatewayReleasePin } from "./catalog.js";
import {
  discoverGateway,
  gatewayCatalog,
  GATEWAY_LOCAL_SETUP_CAPABILITIES,
  GATEWAY_REMOTE_SETUP_CAPABILITIES,
} from "./catalog.js";
import { continuePair, pairingInstructions } from "./continue.js";
import type { DialogContext } from "./dialog.js";
import {
  inputChoice,
  chooseIntent,
  requireAttendedUI,
  reviewLocal,
  selectChoice,
} from "./dialog.js";
import { createPrivate, regularBytes } from "./files.js";
import { requestManagedRestart } from "./managed.js";
import type { ManagedSetup } from "./managed.js";
import type { LocalPlan } from "./plan.js";
import type { RemoteIntent } from "./remote.js";
import { remoteIntent, remoteReview, prepareRemote } from "./remote.js";
import { repairInstallation } from "./repair.js";
import { upgradeLocal } from "./upgrade.js";
import type { ActivatePlan } from "./upgrade.js";

/** Trusted catalog selection; production always uses the shipped `gatewayCatalog`. */
export type SetupOptions = { catalog?: GatewayCatalog };

async function productionBackend(
  agentDir: string | undefined,
  remote: boolean,
  forceFresh: boolean,
  catalog: GatewayCatalog,
): Promise<{ backend?: SetupBackend; description: string }> {
  const requiredCapabilities = remote
    ? GATEWAY_REMOTE_SETUP_CAPABILITIES
    : GATEWAY_LOCAL_SETUP_CAPABILITIES;
  const reusable =
    forceFresh || agentDir === undefined
      ? undefined
      : await reusableExecutable(agentDir, requiredCapabilities);
  if (reusable !== undefined) {
    return {
      description: `Reuse existing setup executable ${reusable}, verified against its recorded SHA256 and required ${requiredCapabilities.join(", ")} capabilities. No download/profile change.`,
      backend: { acquire: async () => reusable },
    };
  }
  const nixExecutable = await discoverNixExecutable();
  // Discovery and every acquisition below use the SAME trusted catalog.
  const discovered = discoverGateway({ nixAvailable: nixExecutable !== undefined }, catalog);
  const pin = selectedSource(discovered);
  if (pin === undefined || discovered.target === undefined) {
    return {
      description: `Acquisition blocked: ${discovered.unavailableReason ?? "No usable verified acquisition route"}. No project/PATH gateway is selected.`,
    };
  }
  const target = discovered.target;
  const method = pin.method;
  const fallback = method === "nix" ? discovered.native : null;
  return {
    description: acquisitionDescription(pin, fallback),
    backend: {
      acquire: async (installRoot, progress) => {
        progress(`Acquiring ${method} gateway`);
        try {
          const result = await acquireGateway(
            {
              ...pin,
              approved: true,
              requiredCapabilities,
              target,
              installRoot,
              deadlineMs: Date.now() + 600_000,
              ...(nixExecutable === undefined ? {} : { nixExecutable }),
            },
            { catalog },
          );
          return result.executable;
        } catch (error) {
          if (fallback === null) {
            throw error;
          }
          progress(
            "Nix acquisition unavailable; using the separately reviewed pinned native fallback",
          );
          const result = await acquireGateway(
            {
              ...fallback,
              approved: true,
              requiredCapabilities,
              method: "native",
              target,
              installRoot,
              deadlineMs: Date.now() + 120_000,
            },
            { catalog },
          );
          return result.executable;
        }
      },
    },
  };
}
function selectedSource(
  discovered: ReturnType<typeof discoverGateway>,
):
  | Omit<
      Extract<AcquisitionPlan, { method: "nix" }>,
      "approved" | "target" | "installRoot" | "deadlineMs"
    >
  | Omit<
      Extract<AcquisitionPlan, { method: "native" }>,
      "approved" | "target" | "installRoot" | "deadlineMs"
    >
  | undefined {
  if (discovered.preferred === "nix" && discovered.nix !== null) {
    return { ...discovered.nix, method: "nix" };
  }
  if (discovered.preferred === "native" && discovered.native !== null) {
    return { ...discovered.native, method: "native" };
  }
  return undefined;
}
export async function setupCommand(
  agentDir: string,
  ctx: DialogContext,
  activate: ActivatePlan,
  supplied?: {
    backend: SetupBackend;
    description: string;
    restart?: (setup: ManagedSetup) => Promise<"acknowledged" | "uncertain">;
  },
  reconnect?: (fresh?: boolean) => Promise<void>,
  options: SetupOptions = {},
): Promise<void> {
  requireAttendedUI(ctx);
  const catalog = options.catalog ?? gatewayCatalog;
  const state = await inspectSetup(agentDir);
  if (await handleExisting(state, agentDir, ctx, activate, catalog, reconnect, supplied)) {
    return;
  }
  const intent = await chooseIntent(ctx);
  if (intent === undefined) {
    ctx.ui.notify("Cancelled — no changes made", "info");
    return;
  }
  const remote = intent === "remote" ? await remoteIntent(ctx) : undefined;
  if (intent === "remote" && remote === undefined) {
    ctx.ui.notify("Cancelled — no changes made", "info");
    return;
  }
  const socketPath = await chooseSocket(ctx, state.paths.socket);
  if (socketPath === undefined) {
    return;
  }
  const socketState = await inspectSetup(agentDir, socketPath);
  const reviewedState = { ...state, sharedInstance: socketState.sharedInstance };
  const pairingDirectory = join(state.paths.directory, `pair-${randomBytes(12).toString("hex")}`);
  const acquisition =
    supplied ?? (await productionBackend(agentDir, remote !== undefined, false, catalog));
  const plan = await reviewLocal(
    ctx,
    {
      ...state.choices,
      machineId: remote?.localMachineId ?? state.choices.machineId,
    },
    socketPath,
    () =>
      [
        `Platform: ${state.platform}; account UID ${process.getuid?.() ?? "unknown"} (not cross-user/root isolation).`,
        acquisition.description,
        ...(remote === undefined ? [] : [remoteReview(remote, pairingDirectory)]),
        `Private files: ${state.paths.gateway}; ${state.paths.metadata}; ${state.paths.adapter}; ${state.paths.journal}; ${state.paths.prepared}; ${state.paths.installed}; ${state.paths.lock}.`,
        `Owned directory ${state.paths.directory}: create-only install-* staging, startup-*.log (bounded native startup output), reset.json recovery ledger, reversible .previous-*/.disabled-* snapshots. No existing directory is chmodded; unknown artifacts are not removed.`,
        `Socket: ${socketPath}. Detached shared process, no OS service definition.`,
        reviewedState.sharedInstance
          ? "A pre-existing shared socket is present (read-only observation, not live readiness). Apply saves configuration then sends exactly ONE machine-bound shared restart request. Other sessions may retain old trust until the old gateway exits. Uncertain restart or generation mismatch means configuration saved; activation pending. No control replay."
          : "No pre-existing shared socket observed. Admission still verifies the exact loaded configuration generation; a concurrent old gateway cannot silently serve this Pi.",
        "Apply acquires a verified gateway into per-attempt staging, then takes its native lock, rechecks unchanged cache/state, preserves any unavailable orphan installation descriptor in a hash-checked .previous-* backup, and writes a recovery ledger/configuration before activating this Pi directly. Failed apply may retain owned files; reset never deletes credentials or revocation floors.",
      ].join("\n"),
    remote !== undefined,
    `${remote === undefined ? "Local only; no TCP." : `Remote ${remote.peerMachineId}: ${remote.endpoint.mode} ${remote.endpoint.address}.`}\n${acquisition.backend === undefined ? "Acquisition BLOCKED: no usable reviewed pin." : "Apply: reviewed acquisition + private config + start."}\n${reviewedState.sharedInstance ? "Existing shared socket: ONE restart after save; uncertain/mismatch means activation pending. Old sessions may retain old trust until exit." : "Guarded admission requires this exact configuration generation."}`,
  );
  if (plan === undefined) {
    ctx.ui.notify("Cancelled — no writes, downloads or gateway starts", "info");
    return;
  }
  if (acquisition.backend === undefined) {
    ctx.ui.notify(`Blocked — ${acquisition.description} No changes made.`, "warning");
    return;
  }
  await applyReviewed(ctx, {
    agentDir,
    state: reviewedState,
    plan,
    backend: acquisition.backend,
    remote,
    pairingDirectory,
    activate,
    restart: supplied?.restart ?? requestManagedRestart,
  });
}
type SetupState = Awaited<ReturnType<typeof inspectSetup>>;
async function handleExisting(
  state: SetupState,
  agentDir: string,
  ctx: DialogContext,
  activate: ActivatePlan,
  catalog: GatewayCatalog,
  reconnect?: (fresh?: boolean) => Promise<void>,
  supplied?: { backend: SetupBackend; description: string },
): Promise<boolean> {
  if (!state.existing && !state.pending) {
    return false;
  }
  if (
    state.existing &&
    !state.pending &&
    (await resumeOwned(agentDir, ctx, activate, catalog, reconnect, supplied))
  ) {
    return true;
  }
  ctx.ui.notify(
    state.pending
      ? "Blocked: interrupted setup ownership ledger exists. Existing files preserved; /comms doctor and /comms reset can disable unchanged owned participation without deleting credentials/floors."
      : "Existing configuration preserved (including custom, external and symlink configurations). Use /comms doctor to diagnose, /comms reconnect to keep the current runtime. Automatic migration/overwrite is not performed.",
    "warning",
  );
  return true;
}
async function resumeOwned(
  agentDir: string,
  ctx: DialogContext,
  activate: ActivatePlan,
  catalog: GatewayCatalog,
  reconnect?: (fresh?: boolean) => Promise<void>,
  supplied?: { backend: SetupBackend; description: string },
): Promise<boolean> {
  if (
    await repairInstallation(
      agentDir,
      ctx,
      async (remote) => supplied ?? (await productionBackend(agentDir, remote, true, catalog)),
      reconnect,
    )
  ) {
    return true;
  }
  if (await continuePair(agentDir, ctx, reconnect)) {
    return true;
  }
  return upgradeLocal(agentDir, ctx, activate, reconnect);
}

async function chooseSocket(ctx: DialogContext, defaultPath: string): Promise<string | undefined> {
  const socketPath = defaultPath;
  if (Buffer.byteLength(socketPath) > 100) {
    const chosen = await inputChoice(
      ctx,
      "Canonical home socket path exceeds the 100-byte Unix bound. Choose a SHORT persistent private owned socket path; never a temporary directory. No changes before Apply.",
      "/persistent/private/path/s",
    );
    if (chosen === undefined) {
      return undefined;
    }
    if (
      !isAbsolute(chosen) ||
      normalize(chosen) !== chosen ||
      Buffer.byteLength(chosen) > 100 ||
      /^\/(?:private\/)?(?:tmp|var\/folders)(?:\/|$)/u.test(chosen)
    ) {
      throw new Error(
        "Choose a normalized absolute persistent socket path <=100 bytes, not OS temporary storage",
      );
    }
    return chosen;
  }
  return socketPath;
}
type ReviewedSetup = {
  agentDir: string;
  state: SetupState;
  plan: LocalPlan;
  backend: SetupBackend;
  remote: RemoteIntent | undefined;
  pairingDirectory: string;
  activate: ActivatePlan;
  restart: typeof requestManagedRestart;
};
async function applyReviewed(
  ctx: DialogContext,
  { agentDir, state, plan, backend, remote, pairingDirectory, activate, restart }: ReviewedSetup,
): Promise<void> {
  let saved = false;
  try {
    const setup = await applyLocal(
      agentDir,
      plan,
      backend,
      (message) => {
        ctx.ui.notify(message, "info");
      },
      remote === undefined
        ? undefined
        : async (executable, selected) => {
            const prepared = await prepareRemote(executable, pairingDirectory, selected, remote);
            const manifest = await regularBytes(join(pairingDirectory, "pairing.json"));
            if (manifest === undefined) {
              throw new Error("Pairing manifest missing");
            }
            await createPrivate(
              join(state.paths.directory, "pairing.json"),
              manifest.toString("utf8"),
            );
            return prepared;
          },
    );
    saved = true;
    if (state.sharedInstance && (await restart(setup)) === "uncertain") {
      ctx.ui.notify(
        "Configuration saved; activation pending: shared restart outcome uncertain. Existing sessions may still use old trust until the old gateway exits. No restart or application request was replayed; Passive /comms reconnect only retries guarded admission; /comms setup → Activate saved configuration offers a separate reviewed restart.",
        "warning",
      );
      return;
    }
    const actual = await loadConfiguration(agentDir);
    if (actual === undefined) {
      throw new Error("Configuration commit missing");
    }
    await activate({ ...plan, adapter: actual }, setup);
    if (remote !== undefined) {
      ctx.ui.notify(await pairingInstructions(agentDir), "info");
    }
    ctx.ui.notify(
      remote === undefined
        ? "Configured and connected locally. Open another participating Pi session to discover it. No model/provider request was made. Remote link: not configured."
        : `Configured and connected locally. Remote ${remote.kind === "join" ? "pending bundle import" : "configured; link readiness unverified"}. Run /comms setup again to continue public offer/CSR/bundle exchange and independently confirm full fingerprints. No model/provider request was made.`,
      "info",
    );
  } catch {
    ctx.ui.notify(
      saved
        ? "Configuration saved; activation pending: guarded gateway registration unavailable or the running gateway serves another configuration generation. Existing sessions may still use old trust until it exits. No restart or application request was replayed; use /comms reconnect."
        : "Apply incomplete or local connection unavailable. No existing configuration was overwritten. Inspect /comms doctor; owned partial files may remain. /comms reconnect retries without replaying uncertain sends; /comms reset disables unchanged owned configuration and preserves credentials/floors.",
      "warning",
    );
  }
}

export async function resetCommand(
  agentDir: string,
  ctx: DialogContext,
  dispose: () => Promise<void>,
): Promise<void> {
  requireAttendedUI(ctx);
  const answer = await selectChoice(
    ctx,
    "Disable this agent directory's participation and close this Pi's runtime. Other already-open Pi sessions remain active. Preserve gateway installation, backups, private keys, CRLs and revocation floors; never kill the shared gateway.",
    ["Cancel — no changes", "Apply — disable owned participation"],
  );
  if (answer !== "Apply — disable owned participation") {
    return;
  }
  try {
    const backup = await resetLocal(agentDir);
    await dispose();
    ctx.ui.notify(
      `Participation disabled for new sessions; this runtime closed. ${backup}. Other running Pi sessions remain unchanged. Gateway exits after the last participant closes.`,
      "info",
    );
  } catch (error) {
    if (error instanceof ResetFailure && error.disabled) {
      await dispose();
    }
    ctx.ui.notify(
      error instanceof ResetFailure
        ? error.message
        : "Reset refused before disabling participation: ownership or configuration differs. External files/runtime preserved; use /comms doctor.",
      "warning",
    );
  }
}

/** Review text for the selected route; only a Nix selection can authorize a native fallback. */
export function acquisitionDescription(
  pin: ({ method: "nix" } & GatewayNixPin) | ({ method: "native" } & GatewayReleasePin),
  fallback: GatewayReleasePin | null,
): string {
  const content =
    pin.method === "nix"
      ? `source NAR hash ${pin.narHash}`
      : `artifact manifest SHA256 ${pin.manifestSha256}`;
  let fallbackClause = "";
  if (pin.method === "nix") {
    fallbackClause =
      fallback === null
        ? "; no published native fallback is available"
        : `; if Nix is unusable/build fails, this Apply also authorizes verified native fallback ${fallback.version} source ${fallback.sourceRevision} manifest SHA256 ${fallback.manifestSha256}`;
  }
  return `Acquire ${pin.version} from reviewed ${pin.method} source ${pin.sourceRevision}, ${content}${fallbackClause}. Private dedicated install, no shell profile or OS service registration.`;
}
