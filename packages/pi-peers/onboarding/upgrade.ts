import type { Schema } from "effect";
import { loadConfiguration, visibleText } from "../adapter/config.js";
import type { Configuration } from "../adapter/config.js";
import { stableValue } from "../protocol/identity.js";
import { activationScreen } from "./activation.js";
import { inspectSetup, readManaged, setupPaths } from "./backend.js";
import { regularBytes } from "./files.js";
import { requestManagedRestart } from "./managed.js";
import type { ManagedSetup } from "./managed.js";
import { actionForm, gateText, opener, withTechnical } from "./menu/forms.js";
import type { Progress } from "./menu/forms.js";
import type { Row, Screen } from "./menu/model.js";
import type { Outcome, Step } from "./menu/progress.js";
import { remoteDraft, remoteGate, remoteRows } from "./menu/remote-form.js";
import { manageForm } from "./menu/setup-form.js";
import type { ManageFormOptions } from "./menu/setup-form.js";
import {
  afterSave,
  attempt,
  failed,
  GATEWAY_CHANGED,
  INCOMPLETE_NEXT,
  pendingOutcome,
  REVIEW_AGAIN,
} from "./outcome.js";
import { currentPlan, localPlan, localReview, savedChoices } from "./plan.js";
import type { LocalChoices, LocalPlan } from "./plan.js";
import { RefusalError, SETTINGS_CHANGED } from "./refusal.js";
import {
  endpointText,
  grantInto,
  joinAddress,
  keptLink,
  linkedPlan,
  OTHER_COMPUTER,
  remoteReview,
  savedLink,
  savedTailscale,
  unlinkedPlan,
} from "./remote.js";
import type { Endpoint, RemoteIntent } from "./remote.js";
import type { ActivatePlan, Reconnect, Restart } from "./route.js";
import {
  findTailscale,
  listenAddress,
  resolveHost,
  TAILSCALE_PATHS,
  tailscaleSelf,
  whoisName,
} from "./tailscale.js";
import type { TailscaleSelf } from "./tailscale.js";
import { saveOwnedPlan } from "./update.js";

export type { ActivatePlan } from "./route.js";

const RECONNECT_STEPS = ["Reconnecting this Pi"] as const;

const EDIT_STEPS = [
  "Saving the settings",
  "Restarting the shared gateway once",
  "Reconnecting this Pi",
] as const;

const LINK_STEP = "Checking Tailscale on this computer";

const RETIRED_NOTICE = "This link uses retired certificates or keys. Link again over Tailscale.";

const LINK_LABEL = "Link a remote computer";

type Manage = {
  readonly agentDir: string;
  readonly config: Configuration;
  readonly setup: ManagedSetup;
  readonly activate: ActivatePlan;
  readonly reconnect: Reconnect | undefined;
  readonly restart: Restart;
  readonly saved: LocalPlan | undefined;
  readonly tailscale: string | undefined;
  readonly upgrade: ((progress: Progress) => Screen) | undefined;
  shared: boolean;
};

type Link = { readonly endpoint: Endpoint; readonly retired: boolean } | undefined;

function linkOf(manage: Manage): Link {
  return manage.saved === undefined ? undefined : savedLink(manage.saved);
}

function retiredFiles(manage: Manage): string {
  return `Old certificate folders (pair-*) in ${visibleText(setupPaths(manage.agentDir).directory)} are no longer used and can be deleted. Setup never deletes them.`;
}

async function keepWork(reconnect: Reconnect | undefined, step: Step): Promise<Outcome> {
  step(RECONNECT_STEPS[0]);

  try {
    await reconnect?.();
  } catch {
    return failed(
      "Reconnect failed",
      "the gateway did not accept this Pi",
      "Choose Setup › Activate saved configuration.",
    );
  }

  return {
    ok: true,
    headline: "✓ Reconnected with the saved settings",
    facts: [],
    next: "Nothing was changed. Open another Pi session to collaborate.",
  };
}

function canonical(value: Schema.Json): string {
  return JSON.stringify(stableValue(value));
}

function rebuilder(manage: Manage): ((choices: LocalChoices) => LocalPlan) | undefined {
  const { config, saved } = manage;

  if (saved === undefined) {
    return undefined;
  }

  try {
    const rebuild = (choices: LocalChoices): LocalPlan =>
      keptLink(localPlan(choices, config.socketPath), saved);

    const again = rebuild(saved.choices);
    const normal = keptLink(saved, saved);

    return canonical(again.adapter) === canonical(normal.adapter) &&
      canonical(again.gateway) === canonical(normal.gateway)
      ? rebuild
      : undefined;
  } catch {
    return undefined;
  }
}

function changed(plan: LocalPlan): Array<[string, string]> {
  return [
    ["Machine", visibleText(plan.choices.machineId)],
    ["Scope", visibleText(plan.choices.scopeId)],
    ["Label", visibleText(plan.choices.label)],
    ["Permissions", plan.choices.permissions.join(", ") || "none"],
  ];
}

const EDIT_PENDING_NEXT =
  "Choose Setup › Activate saved configuration, or start a new Pi session to use the saved settings.";

type Change = {
  readonly plan: LocalPlan;
  readonly failure: string;
  readonly done: Outcome;
};

async function changeWork(manage: Manage, change: Change, step: Step): Promise<Outcome> {
  const { agentDir, setup, activate } = manage;
  const { plan } = change;
  step(EDIT_STEPS[0]);
  const observed = await inspectSetup(agentDir, setup.socketPath);

  if (observed.sharedInstance !== manage.shared) {
    manage.shared = observed.sharedInstance;

    return failed(change.failure, GATEWAY_CHANGED, REVIEW_AGAIN);
  }

  await saveOwnedPlan(agentDir, setup, plan, true);

  const technical = [
    manage.shared
      ? "Settings saved. The shared gateway was asked to restart once."
      : "Settings saved.",
  ];

  try {
    if (manage.shared) {
      step(EDIT_STEPS[1]);

      if ((await manage.restart(setup)) === "uncertain") {
        return pendingOutcome("Settings saved", EDIT_PENDING_NEXT, [
          ...technical,
          "The gateway restart was not confirmed.",
        ]);
      }
    }

    step(EDIT_STEPS[2]);
    const updated = await readManaged(agentDir, plan.adapter);

    if (updated === undefined) {
      throw new Error("The updated setup record is missing");
    }

    await activate(plan, updated, true);
  } catch (error) {
    return afterSave(error instanceof Error ? error : undefined, technical);
  }

  return {
    ...change.done,
    technical: [...technical, "This Pi runtime explicitly replaced while idle."],
  };
}

function plannedSteps(manage: Manage, first: ReadonlyArray<string> = []): Array<string> {
  return [...first, ...(manage.shared ? EDIT_STEPS : [EDIT_STEPS[0], EDIT_STEPS[2]])];
}

async function freshPlan(manage: Manage): Promise<LocalPlan> {
  const config = await loadConfiguration(manage.agentDir);
  const bytes = await regularBytes(setupPaths(manage.agentDir).gateway);

  if (config === undefined || bytes === undefined) {
    throw SETTINGS_CHANGED();
  }

  return currentPlan(config, bytes);
}

const CHANGE_LINES = [
  "This Pi reconnects with a fresh identity, so its inbox is lost. Other open sessions keep their old settings until they restart.",
  "The shared gateway restarts once; nothing is resent.",
];

const CHANGE_TECHNICAL =
  "Owned config/metadata replaced only by CAS under the setup lock; .previous-* snapshots kept. No blanket /reload, process/PID killing or uncertain-send replay.";

function tailnetName(self: TailscaleSelf, machine: string): void {
  if (self.name !== machine) {
    throw new RefusalError(
      `this computer's tailnet name is ${visibleText(self.name)} but its machine name is ${visibleText(machine)}`,
      `Change Machine to ${visibleText(self.name)} in Setup, or rename this computer in Tailscale, then link again`,
    );
  }
}

async function otherAddress(command: string, self: TailscaleSelf, host: string): Promise<string> {
  const address = await resolveHost(command, host);

  if (self.addresses.includes(address)) {
    throw new RefusalError(
      "that address is this computer",
      "Enter the other computer's MagicDNS name or tailnet IP",
    );
  }

  return address;
}

type LinkTarget = { readonly endpoint: Endpoint; readonly other: string | undefined };

async function linkEndpoint(
  command: string,
  self: TailscaleSelf,
  intent: RemoteIntent,
): Promise<LinkTarget> {
  if (intent.mode === "listen") {
    const endpoint: Endpoint = {
      mode: "listen",
      address: joinAddress(listenAddress(self), intent.port),
    };

    return intent.host === ""
      ? { endpoint, other: undefined }
      : {
          endpoint,
          other: await whoisName(command, await otherAddress(command, self, intent.host)),
        };
  }

  const address = await otherAddress(command, self, intent.host);

  return {
    endpoint: { mode: "connect", address: joinAddress(address, intent.port) },
    other: await whoisName(command, address),
  };
}

function grantNext(other: string | undefined, grant: Schema.Json): string {
  const json = JSON.stringify(grant);

  return other === undefined
    ? `Add this grant to your tailnet policy, with ${OTHER_COMPUTER} replaced by the other computer's tailnet name (the first label of its MagicDNS name), so it may use sessions here: ${json}`
    : `Add this grant to your tailnet policy so ${visibleText(other)} may use sessions here: ${json}`;
}

async function linkWork(manage: Manage, intent: RemoteIntent, step: Step): Promise<Outcome> {
  step(LINK_STEP);
  const configured = manage.tailscale ?? savedTailscale(manage.saved);
  const command = await findTailscale(configured === undefined ? TAILSCALE_PATHS : [configured]);
  const self = await tailscaleSelf(command);
  tailnetName(self, manage.config.machineId);
  const { endpoint, other } = await linkEndpoint(command, self, intent);
  const plan = linkedPlan(await freshPlan(manage), endpoint, configured);

  const grant = grantInto(
    self.name,
    other ?? OTHER_COMPUTER,
    plan.choices.scopeId,
    intent.mode === "listen" ? intent.port : undefined,
  );

  return changeWork(
    manage,
    {
      plan,
      failure: "Linking failed",
      done: {
        ok: true,
        headline: `✓ Linked over Tailscale — ${endpointText(endpoint)}`,
        facts: [
          ["This computer", visibleText(self.name)],
          ["Endpoint", endpointText(endpoint)],
        ],
        next: `${grantNext(other, grant)}. Then link the other computer the same way and choose Doctor (see docs/remote-setup.md).`,
      },
    },
    step,
  );
}

const LINK_NOTE = `Link this computer with one other computer over Tailscale. One computer listens on its tailnet IP and the other connects to it. Nothing changes until you choose Link.`;

function linkForm(manage: Manage, progress: Progress): Screen {
  const link = linkOf(manage);
  const draft = remoteDraft(link?.retired === false ? link.endpoint : undefined);
  const gate = () => remoteGate(draft);

  return actionForm({
    title: "Link",
    note: LINK_NOTE,
    rows: () => remoteRows(draft),
    details: () => {
      const current = gate();

      return withTechnical(
        [
          ...(current.kind === "ready"
            ? remoteReview(current.value, manage.config.machineId)
            : [`Link is not ready: ${gateText(current)}`]),
          ...CHANGE_LINES,
          ...(link?.retired === true ? [retiredFiles(manage)] : []),
        ],
        [CHANGE_TECHNICAL],
      );
    },
    detailsDescription: "What linking checks, changes and restarts.",
    consent: () => ({
      label: "Link",
      action: "Link",
      gate: gate(),
      description:
        "Check Tailscale, save the link, restart the gateway once and reconnect this Pi.",
      run: (intent) => {
        progress("Linking", plannedSteps(manage, [LINK_STEP]), async (step) =>
          attempt("Linking failed", INCOMPLETE_NEXT, async () => linkWork(manage, intent, step)),
        );
      },
    }),
  });
}

async function unlinkWork(manage: Manage, endpoint: Endpoint, step: Step): Promise<Outcome> {
  return changeWork(
    manage,
    {
      plan: unlinkedPlan(await freshPlan(manage)),
      failure: "Removing the link failed",
      done: {
        ok: true,
        headline: "✓ Remote link removed",
        facts: [["Was", endpointText(endpoint)]],
        next: "This computer no longer listens or connects. Remove the link on the other computer, and its grants from your tailnet policy.",
      },
    },
    step,
  );
}

function unlinkForm(manage: Manage, endpoint: Endpoint, progress: Progress): Screen {
  return actionForm({
    title: "Remove link",
    note: `Stop ${endpointText(endpoint)}. Nothing changes until you choose Remove link.`,
    details: () =>
      withTechnical(
        [
          "Removes the remote link. Local sessions keep working. Your tailnet policy is not changed.",
          ...CHANGE_LINES,
        ],
        [CHANGE_TECHNICAL],
      ),
    detailsDescription: "What removing the link changes and restarts.",
    consent: () => ({
      label: "Remove link",
      action: "Remove",
      gate: { kind: "ready", value: undefined },
      description: "Remove the link, restart the gateway once and reconnect this Pi.",
      run: () => {
        progress("Removing the link", plannedSteps(manage), async (step) =>
          attempt("Removing the link failed", INCOMPLETE_NEXT, async () =>
            unlinkWork(manage, endpoint, step),
          ),
        );
      },
    }),
  });
}

function editDetails(manage: Manage, plan: LocalPlan | undefined): Array<string> {
  const link = linkOf(manage);

  return withTechnical(
    [
      "Applies to every project on this account. Peer messages may wake the model, which costs provider usage.",
      manage.shared
        ? "Apply saves the changes, restarts the shared gateway once and reconnects this Pi. Other sessions briefly disconnect and keep the old settings until they restart."
        : "Apply saves the changes and connects this Pi with them. Other sessions keep the old settings until they restart.",
      "This Pi reconnects with a fresh identity, so its inbox is lost. The gateway install is kept.",
      ...(link === undefined
        ? []
        : [
            "The remote link is kept. Your tailnet policy, not these permissions, decides what other computers may do here.",
          ]),
    ],
    [
      ...(plan === undefined ? [] : [localReview(plan, link !== undefined)]),
      `Owned config/metadata replaced only by CAS under the setup lock; .previous-* snapshots kept. Socket ${visibleText(manage.config.socketPath)} unchanged. ${manage.shared ? "Exactly ONE machine-bound shared restart request; an uncertain outcome is never replayed." : "No live shared socket observed; no restart request."} This Pi runtime is replaced only while idle, with a new nonce. No send replay.`,
    ],
  );
}

function linkScreen(manage: Manage, progress: Progress): Screen {
  if (manage.upgrade !== undefined) {
    return manage.upgrade(progress);
  }

  return linkForm(manage, progress);
}

function linkRows(manage: Manage, progress: Progress): Array<Row> {
  const link = linkOf(manage);

  let description = "Link one other computer over Tailscale.";

  if (link !== undefined) {
    description = link.retired
      ? "Link again over Tailscale. This replaces the retired link."
      : `Change the link (${endpointText(link.endpoint)}), or link another computer instead.`;
  }

  return [
    opener("link", LINK_LABEL, description, () => linkScreen(manage, progress)),
    ...(link === undefined
      ? []
      : [
          opener("unlink", "Remove the remote link", `Stop ${endpointText(link.endpoint)}.`, () =>
            unlinkForm(manage, link.endpoint, progress),
          ),
        ]),
  ];
}

function actionRows(manage: Manage, progress: Progress): Array<Row> {
  const { setup, reconnect } = manage;

  return [
    {
      id: "keep",
      label: "Keep and reconnect",
      value: "",
      description: "Keep the saved settings and reconnect this Pi. Nothing is written.",
      activation: {
        kind: "consent",
        action: "Reconnect",
        run: () => {
          progress(
            "Reconnecting",
            RECONNECT_STEPS,
            async (step) => keepWork(reconnect, step),
            undefined,
            "reconnect",
          );
        },
      },
    },
    opener(
      "activate",
      "Activate saved configuration",
      "Restart the gateway once so it uses the saved settings.",
      () => activationScreen(setup, progress, reconnect),
    ),
    ...linkRows(manage, progress),
  ];
}

async function savedPlan(agentDir: string, config: Configuration): Promise<LocalPlan | undefined> {
  try {
    const bytes = await regularBytes(setupPaths(agentDir).gateway);

    return bytes === undefined ? undefined : currentPlan(config, bytes);
  } catch {
    return undefined;
  }
}

export async function manageRoute(
  agentDir: string,
  activate: ActivatePlan,
  reconnect: Reconnect | undefined,
  restart: Restart = requestManagedRestart,
  upgrade?: (progress: Progress) => Screen,
  tailscale?: string,
): Promise<((progress: Progress) => Screen) | undefined> {
  const config = await loadConfiguration(agentDir);

  if (config === undefined) {
    return undefined;
  }

  const setup = await readManaged(agentDir, config);

  if (setup === undefined) {
    return undefined;
  }

  const observed = await inspectSetup(agentDir, setup.socketPath);

  const manage: Manage = {
    agentDir,
    config,
    setup,
    activate,
    reconnect,
    restart,
    saved: await savedPlan(agentDir, config),
    tailscale,
    upgrade,
    shared: observed.sharedInstance,
  };

  const rebuild = rebuilder(manage);

  return (progress) => manageScreen(manage, rebuild, progress);
}

function manageNote(manage: Manage): string {
  const machine = visibleText(manage.config.machineId);
  const link = linkOf(manage);

  if (link === undefined) {
    return `Peers is set up on this computer as ${machine}. Nothing changes until you choose Apply.`;
  }

  return link.retired
    ? `Set up as ${machine}. ${RETIRED_NOTICE} Choose ${LINK_LABEL}. ${retiredFiles(manage)}`
    : `Set up as ${machine}, linked over Tailscale (${endpointText(link.endpoint)}). Nothing changes until you choose Apply.`;
}

function manageScreen(
  manage: Manage,
  rebuild: ManageFormOptions["rebuild"],
  progress: Progress,
): Screen {
  const link = linkOf(manage);

  const options: ManageFormOptions = {
    saved: savedChoices(manage.config),
    note: manageNote(manage),
    shared: () => manage.shared,
    details: (plan) => editDetails(manage, plan),
    apply: (plan) => {
      progress("Applying", plannedSteps(manage), async (step) =>
        attempt("Changing settings failed", INCOMPLETE_NEXT, async () =>
          changeWork(
            manage,
            {
              plan,
              failure: "Changing settings failed",
              done: {
                ok: true,
                headline: `✓ Settings changed — connected as ${visibleText(plan.adapter.machineId)}`,
                facts: changed(plan),
                next: "Other open Pi sessions keep the old settings until they restart.",
              },
            },
            step,
          ),
        ),
      );
    },
    actions: () => actionRows(manage, progress),
  };

  if (link !== undefined) {
    options.fixedMachine =
      "Can't change here: while linked it must match this computer's tailnet name. Remove the remote link to rename it.";
    options.linked = true;
  }

  if (rebuild !== undefined) {
    options.rebuild = rebuild;
  }

  return manageForm(options);
}
