import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadConfiguration, visibleText } from "../adapter/config.js";
import type { AcquisitionPlan } from "./acquire.js";
import { acquireGateway, discoverNixExecutable } from "./acquire.js";
import {
  applyLocal,
  inspectSetup,
  resetLocal,
  ResetFailure,
  ResetRefused,
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
import { exchangeFacts, exchangeNext, readPairing } from "./continue.js";
import { requireAttendedUI } from "./dialog.js";
import { createPrivate, regularBytes } from "./files.js";
import { requestManagedRestart } from "./managed.js";
import type { ManagedSetup } from "./managed.js";
import { report, withTechnical } from "./menu/forms.js";
import type { Progress } from "./menu/forms.js";
import type { MenuModel } from "./menu/model.js";
import { outcomeText } from "./menu/progress.js";
import type { Outcome, Step } from "./menu/progress.js";
import { remoteDraft } from "./menu/remote-form.js";
import { peersMenu } from "./menu/root.js";
import { runMenu } from "./menu/run.js";
import type { MenuContext } from "./menu/run.js";
import { setupForm } from "./menu/setup-form.js";
import type { SetupChoice, SetupDraft } from "./menu/setup-form.js";
import {
  afterSave,
  failed,
  INCOMPLETE_NEXT,
  pendingOutcome,
  safeReason,
  SAVED_NEXT,
} from "./outcome.js";
import { localReview } from "./plan.js";
import type { LocalPlan } from "./plan.js";
import type { RemoteIntent } from "./remote.js";
import { remoteReview, prepareRemote } from "./remote.js";
import { repairRoute } from "./repair.js";
import type { Acquisition, ActivatePlan, Notice, Reconnect, Restart, SetupRoute } from "./route.js";
import { NO_CHANGES, SETUP_STEPS } from "./route.js";
import { manageRoute } from "./upgrade.js";

/** Trusted catalog selection; production always uses the shipped `gatewayCatalog`. */
export type SetupOptions = { catalog?: GatewayCatalog };

async function productionBackend(
  agentDir: string | undefined,
  remote: boolean,
  forceFresh: boolean,
  catalog: GatewayCatalog,
): Promise<Acquisition> {
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
      blocked: discovered.unavailableReason ?? "No usable verified acquisition route",
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
export type Supplied = {
  backend: SetupBackend;
  description: string;
  restart?: (setup: ManagedSetup) => Promise<"acknowledged" | "uncertain">;
};
type SetupState = Awaited<ReturnType<typeof inspectSetup>>;

const BLOCKED = "no verified gateway download";

function blockedNotice(acquisition: Acquisition): Notice {
  return {
    message: `Blocked — ${acquisition.blocked ?? BLOCKED}. See the pi-peers README for manual setup. No changes made.`,
    level: "warning",
  };
}

function reportRoute(
  value: string,
  description: string,
  lines: readonly string[],
  notice: Notice,
): SetupRoute {
  return {
    value,
    description,
    configured: true,
    screen: () => report("Setup", () => lines),
    cancelled: () => notice,
  };
}

/** An unreadable or externally changed setup file: Status, Doctor and Reset still work. */
function unreadableRoute(error: unknown): SetupRoute {
  const reason = safeReason(error, "");
  const what = reason === "" ? "setup files unreadable" : "setup files changed";
  return reportRoute(
    `Blocked: ${what} — choose Doctor`,
    "Setup can't read its saved files safely, so it changes nothing.",
    withTechnical(
      [
        `Setup stopped because its ${what.replace("setup files ", "files are ")}. Nothing was changed.`,
        "Next: choose Doctor to see which file, fix or move it aside, then open Setup again.",
      ],
      reason === "" ? [] : [reason],
    ),
    {
      message: `Setup blocked: ${what}. Choose Doctor in /peers. No changes made.`,
      level: "warning",
    },
  );
}

const PENDING_LINES = withTechnical(
  [
    "A previous setup or reset was interrupted, so setup changes nothing until that is resolved. Your files and keys were kept.",
    "Next: choose Doctor to see what was interrupted, then Reset to turn peers off safely. Keys and revocation floors are kept.",
  ],
  [
    "Interrupted setup ownership ledger exists. Existing files preserved; reset can disable unchanged owned participation without deleting credentials/floors.",
  ],
);

const EXTERNAL_LINES = withTechnical(
  [
    "Peers is configured outside setup (for example a hand-written or linked pi-peers.json), so setup won't change it.",
    "Next: edit that file yourself, choose Doctor to check it, or Reconnect to use it now.",
  ],
  [
    "Existing configuration preserved (including custom, external and symlink configurations). Automatic migration/overwrite is not performed.",
  ],
);

async function existingRoute(
  agentDir: string,
  state: SetupState,
  activate: ActivatePlan,
  supplied: Supplied | undefined,
  reconnect: Reconnect | undefined,
  catalog: GatewayCatalog,
): Promise<SetupRoute> {
  if (state.pending) {
    return reportRoute("Interrupted", "A previous setup was interrupted.", PENDING_LINES, {
      message:
        "Setup was interrupted earlier. Choose Doctor, then Reset, in /peers. No changes made.",
      level: "warning",
    });
  }
  const repair = await repairRoute(
    agentDir,
    async (remote) => supplied ?? (await productionBackend(agentDir, remote, true, catalog)),
    reconnect,
  );
  if (repair !== undefined) {
    return {
      value: "Repair needed",
      description: "The installed gateway program needs repair.",
      configured: true,
      screen: repair.screen,
      cancelled: () =>
        repair.blocked
          ? {
              message: `Repair blocked — ${BLOCKED} for this platform. No changes made.`,
              level: "warning",
            }
          : NO_CHANGES,
    };
  }
  const screen = await manageRoute(
    agentDir,
    activate,
    reconnect,
    supplied?.restart ?? requestManagedRestart,
  );
  if (screen !== undefined) {
    return {
      value: "Manage",
      description: "View or change the saved setup.",
      configured: true,
      screen,
      cancelled: () => NO_CHANGES,
    };
  }
  return reportRoute(
    "Managed outside setup",
    "Peers is configured by hand, so setup changes nothing.",
    EXTERNAL_LINES,
    {
      message: "Peers is configured outside setup, so setup changes nothing. No changes made.",
      level: "info",
    },
  );
}

type Fresh = {
  readonly agentDir: string;
  readonly state: SetupState;
  readonly draft: SetupDraft;
  readonly activate: ActivatePlan;
  readonly restart: Restart;
  readonly pairingDirectory: string;
};

async function applyChoice(
  fresh: Fresh,
  choice: SetupChoice,
  acquisition: Acquisition,
  step: Step,
): Promise<Outcome> {
  const { agentDir, state, draft } = fresh;
  const { backend } = acquisition;
  if (backend === undefined) {
    return failed(
      "Setup failed",
      BLOCKED,
      "Nothing was changed. See the pi-peers README for manual setup.",
    );
  }
  const socket = await inspectSetup(agentDir, choice.plan.adapter.socketPath);
  if (socket.sharedInstance !== choice.shared) {
    draft.shared = socket.sharedInstance;
    return {
      ok: false,
      headline: "✗ Gateway state changed — review again",
      facts: [],
      next: "Nothing was changed. Open Review details, then choose Apply again.",
    };
  }
  return applyReviewed(
    {
      agentDir,
      state: { ...state, sharedInstance: choice.shared },
      plan: choice.plan,
      backend,
      remote: choice.remote,
      pairingDirectory: fresh.pairingDirectory,
      activate: fresh.activate,
      restart: fresh.restart,
    },
    step,
  );
}

async function freshRoute(
  agentDir: string,
  state: SetupState,
  activate: ActivatePlan,
  supplied: Supplied | undefined,
  catalog: GatewayCatalog,
): Promise<SetupRoute> {
  const [local, remote] =
    supplied === undefined
      ? await Promise.all([
          productionBackend(agentDir, false, false, catalog),
          productionBackend(agentDir, true, false, catalog),
        ])
      : [supplied, supplied];
  const required = Buffer.byteLength(state.paths.socket) > 100;
  const draft: SetupDraft = {
    mode: "local",
    choices: state.choices,
    socket: required ? "" : state.paths.socket,
    socketRequired: required,
    shared: required ? false : state.sharedInstance,
    remote: remoteDraft(),
  };
  const fresh: Fresh = {
    agentDir,
    state,
    draft,
    activate,
    restart: supplied?.restart ?? requestManagedRestart,
    pairingDirectory: join(state.paths.directory, `pair-${randomBytes(12).toString("hex")}`),
  };
  const acquisitionOf = (choice: { readonly remote?: RemoteIntent }): Acquisition =>
    choice.remote === undefined ? local : remote;
  const screen = (progress: Progress) =>
    setupForm({
      draft,
      ...(local.backend === undefined ? { blocked: BLOCKED } : {}),
      ...(remote.backend === undefined ? { remoteBlocked: BLOCKED } : {}),
      probe: async (socket) => {
        const observed = await inspectSetup(agentDir, socket);
        return observed.sharedInstance;
      },
      details: (choice) =>
        `${localReview(choice.plan, choice.remote !== undefined)}\n${effectReview(
          state,
          choice.shared,
          acquisitionOf(choice),
          choice.plan.adapter.socketPath,
          choice.remote === undefined
            ? undefined
            : { intent: choice.remote, directory: fresh.pairingDirectory },
        )}`,
      apply: (choice) => {
        progress("Applying", SETUP_STEPS, async (step) =>
          applyChoice(fresh, choice, acquisitionOf(choice), step),
        );
      },
    });
  return {
    value: "Set up",
    description: "Connect this Pi to other sessions. Nothing changes until Apply.",
    configured: false,
    screen,
    cancelled: () => {
      const acquisition = draft.mode === "remote" ? remote : local;
      return acquisition.backend === undefined ? blockedNotice(acquisition) : NO_CHANGES;
    },
  };
}

/**
 * Builds the Setup route without effects: the fresh form (local or one remote peer), or the
 * existing-state screen (repair, continue pairing, upgrade), or a plain report for interrupted,
 * external or unreadable state. Any error while reading becomes a blocked report, never a crash.
 */
export async function prepareSetup(
  agentDir: string,
  activate: ActivatePlan,
  supplied?: Supplied,
  reconnect?: Reconnect,
  options: SetupOptions = {},
): Promise<SetupRoute> {
  const catalog = options.catalog ?? gatewayCatalog;
  try {
    const state = await inspectSetup(agentDir);
    return state.existing || state.pending
      ? await existingRoute(agentDir, state, activate, supplied, reconnect, catalog)
      : await freshRoute(agentDir, state, activate, supplied, catalog);
  } catch (error) {
    return unreadableRoute(error);
  }
}

async function unavailable(): Promise<Outcome> {
  return failed("Not available here", "use the full menu", "Run /peers.");
}

/** `/peers setup` without the rest of the root: the Setup screen pushed, driven to completion. */
export async function setupCommand(
  agentDir: string,
  ctx: MenuContext,
  activate: ActivatePlan,
  supplied?: Supplied,
  reconnect?: Reconnect,
  options: SetupOptions = {},
): Promise<void> {
  requireAttendedUI(ctx);
  const route = await prepareSetup(agentDir, activate, supplied, reconnect, options);
  const holder: { model?: MenuModel } = {};
  holder.model = peersMenu(
    {
      state: () => ({
        status: { value: "", lines: ["Run /peers status for details."] },
        doctor: ["Run /peers doctor for details."],
        setup: route,
        resettable: false,
        busy: false,
      }),
      reset: unavailable,
      reconnect: unavailable,
      started: () => undefined,
      finished: (outcome) => {
        ctx.ui.notify(outcomeText(outcome), outcome.ok ? "info" : "warning");
        holder.model?.close();
      },
    },
    undefined,
    "setup",
  );
  await runMenu(ctx, holder.model, () => {
    const notice = route.cancelled();
    ctx.ui.notify(notice.message, notice.level);
  });
}

function effectReview(
  state: SetupState,
  shared: boolean,
  acquisition: Acquisition,
  socketPath: string,
  remote?: { readonly intent: RemoteIntent; readonly directory: string },
): string {
  return [
    `Platform: ${state.platform}; account UID ${process.getuid?.() ?? "unknown"} (not cross-user/root isolation).`,
    acquisition.description,
    ...(remote === undefined ? [] : [remoteReview(remote.intent, remote.directory)]),
    `Private files: ${state.paths.gateway}; ${state.paths.metadata}; ${state.paths.adapter}; ${state.paths.journal}; ${state.paths.prepared}; ${state.paths.installed}; ${state.paths.lock}.`,
    `Owned directory ${state.paths.directory}: create-only install-* staging, startup-*.log (bounded native startup output), reset.json recovery ledger, reversible .previous-*/.disabled-* snapshots. No existing directory is chmodded; unknown artifacts are not removed.`,
    `Socket: ${socketPath}. Detached shared process, no OS service definition: the first participating Pi starts it and the last closes it.`,
    shared
      ? "A pre-existing shared socket is present (read-only observation, not live readiness). Apply saves configuration then sends exactly ONE machine-bound shared restart request. Other sessions may retain old trust until the old gateway exits. Uncertain restart or generation mismatch means configuration saved; activation pending. No control replay."
      : "No pre-existing shared socket observed. Admission still verifies the exact loaded configuration generation; a concurrent old gateway cannot silently serve this Pi.",
    "Apply acquires a verified gateway into per-attempt staging, then takes its native lock, rechecks unchanged cache/state, preserves any unavailable orphan installation descriptor in a hash-checked .previous-* backup, and writes a recovery ledger/configuration before activating this Pi directly. Failed apply may retain owned files; reset never deletes credentials or revocation floors.",
  ].join("\n");
}

type ReviewedSetup = {
  agentDir: string;
  state: SetupState;
  plan: LocalPlan;
  backend: SetupBackend;
  remote: RemoteIntent | undefined;
  pairingDirectory: string;
  activate: ActivatePlan;
  restart: Restart;
};

async function success(
  agentDir: string,
  plan: LocalPlan,
  state: SetupState,
  remote: RemoteIntent | undefined,
): Promise<Outcome> {
  const pairing = remote === undefined ? undefined : await readPairing(agentDir);
  const machine = visibleText(plan.adapter.machineId);
  return {
    ok: true,
    headline: `✓ Peers set up — connected as ${machine}`,
    facts: [
      ["Machine", machine],
      ["Scope", visibleText(plan.choices.scopeId)],
      ["Permissions", plan.choices.permissions.join(", ") || "none"],
      ["Config file", visibleText(state.paths.adapter)],
      ["Gateway socket", visibleText(plan.adapter.socketPath)],
      [
        "Remote",
        remote === undefined
          ? "Not configured"
          : `${visibleText(remote.peerMachineId)} (${remote.endpoint.mode} ${remote.endpoint.address}), exchange pending`,
      ],
      ...(pairing === undefined ? [] : exchangeFacts(pairing)),
    ],
    next:
      pairing === undefined
        ? "Open another Pi session to collaborate. No model request was made."
        : `${exchangeNext(pairing)} Setup › View public exchange instructions shows this again.`,
  };
}

/** Plain step labels for applyLocal's progress messages. */
function stepLabel(message: string): string {
  if (message.startsWith("Nix acquisition unavailable")) {
    return "Using the verified download instead";
  }
  if (message.startsWith("Acquiring")) {
    return SETUP_STEPS[0];
  }
  return message.startsWith("Applying") ? SETUP_STEPS[1] : message;
}

const SAVED =
  "Configuration saved; activation pending: guarded gateway registration unavailable or the running gateway serves another configuration generation. Existing sessions may still use old trust until it exits. No restart or application request was replayed; use /peers reconnect.";
const INCOMPLETE =
  "Apply incomplete or local connection unavailable. No existing configuration was overwritten. Inspect /peers doctor; owned partial files may remain. /peers reconnect retries without replaying uncertain sends; /peers reset disables unchanged owned configuration and preserves credentials/floors.";

async function applyReviewed(reviewed: ReviewedSetup, step: Step): Promise<Outcome> {
  const { agentDir, state, plan, backend, remote, pairingDirectory, activate, restart } = reviewed;
  let saved = false;
  try {
    const setup = await applyLocal(
      agentDir,
      plan,
      backend,
      (message) => {
        step(stepLabel(message));
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
    step(SETUP_STEPS[2]);
    if (state.sharedInstance && (await restart(setup)) === "uncertain") {
      return pendingOutcome("Settings saved", SAVED_NEXT, [
        "Configuration saved; activation pending: shared restart outcome uncertain. Existing sessions may still use old trust until the old gateway exits. No restart or application request was replayed; passive reconnect only retries guarded admission; Setup › Activate saved configuration offers a separate reviewed restart.",
      ]);
    }
    const actual = await loadConfiguration(agentDir);
    if (actual === undefined) {
      throw new Error("Configuration commit missing");
    }
    await activate({ ...plan, adapter: actual }, setup);
    return await success(agentDir, plan, state, remote);
  } catch (error) {
    return saved
      ? afterSave(error, [SAVED])
      : failed(
          "Setup failed",
          safeReason(error, "Apply did not finish; details withheld"),
          INCOMPLETE_NEXT,
          [INCOMPLETE],
        );
  }
}

/** Disables owned participation; `dispose` closes this Pi's runtime once disabled. */
export async function resetOutcome(
  agentDir: string,
  dispose: () => Promise<void>,
): Promise<Outcome> {
  try {
    const backup = await resetLocal(agentDir);
    await dispose();
    const path = backup.startsWith("/");
    return {
      ok: true,
      headline: "✓ Peers turned off",
      facts: path ? [["Saved copy", visibleText(backup)]] : [],
      next: "Other open Pi sessions stay connected until they close. Choose Setup to turn peers back on.",
      technical: [
        "Participation disabled for new sessions; this runtime closed. Gateway exits after the last participant closes. Credentials and floors retained.",
        ...(path ? [] : [backup]),
      ],
    };
  } catch (error) {
    if (error instanceof ResetFailure && error.disabled) {
      await dispose();
      return {
        ok: false,
        headline: "✗ Reset partly done — peers is off",
        facts: [],
        next: "Choose Reset again to finish. Keys and revocation floors are kept.",
        technical: [error.message],
      };
    }
    return {
      ok: false,
      headline: `✗ Reset refused — ${error instanceof ResetFailure ? "nothing was turned off" : resetRefusal(error)}`,
      facts: [],
      next: "Nothing was turned off. Choose Doctor to see what differs.",
      technical: [
        "Reset refused before disabling participation. External files/runtime preserved.",
      ],
    };
  }
}

/**
 * Reset's own refusals explain themselves. Any other error (a system error, a JSON parse or schema
 * error) may quote a path or file content, so it gets the generic reason.
 */
function resetRefusal(error: unknown): string {
  return error instanceof ResetRefused
    ? error.message.replace(/\.$/u, "")
    : "ownership or configuration differs";
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
