import type { Schema } from "effect";
import { loadConfiguration, visibleText } from "../adapter/config.js";
import type { Configuration } from "../adapter/config.js";
import { stableValue } from "../protocol/identity.js";
import { activationScreen } from "./activation.js";
import { inspectSetup, readManaged, setupPaths } from "./backend.js";
import { regularBytes } from "./files.js";
import { ensureKey, keyPaths, savedKey } from "./keys.js";
import { requestManagedRestart } from "./managed.js";
import type { ManagedSetup } from "./managed.js";
import { actionForm, gateText, opener, withTechnical } from "./menu/forms.js";
import type { Progress } from "./menu/forms.js";
import type { Row, Screen } from "./menu/model.js";
import type { Outcome, Step } from "./menu/progress.js";
import { remoteDraft, remoteGate, remoteRows, remoteSummary } from "./menu/remote-form.js";
import { manageForm, peerGrantText } from "./menu/setup-form.js";
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
import { keptLink, linkedPeer, linkedPlan, remoteReview, unlinkedPlan } from "./remote.js";
import type { RemoteIntent } from "./remote.js";
import type { ActivatePlan, Reconnect, Restart } from "./route.js";
import { isPinnedRemote } from "./schema.js";
import { saveOwnedPlan } from "./update.js";

export type { ActivatePlan } from "./route.js";

const RECONNECT_STEPS = ["Reconnecting this Pi"] as const;
const KEY_STEPS = ["Creating or reading this computer's key"] as const;

const EDIT_STEPS = [
  "Saving the settings",
  "Restarting the shared gateway once",
  "Reconnecting this Pi",
] as const;

const LINK_STEP = "Checking this computer's key";

export const RETIRED_NOTICE = "This link uses retired certificates. Link again with keys.";

const LINK_LABEL = "Link a remote computer";

type Manage = {
  readonly agentDir: string;
  readonly config: Configuration;
  readonly setup: ManagedSetup;
  readonly activate: ActivatePlan;
  readonly reconnect: Reconnect | undefined;
  readonly restart: Restart;
  readonly saved: LocalPlan | undefined;
  readonly ownKey: string | undefined;
  readonly upgrade: ((progress: Progress) => Screen) | undefined;
  shared: boolean;
};

type Link = { readonly peer: string; readonly retired: boolean } | undefined;

function linkOf(manage: Manage): Link {
  const { saved } = manage;
  const peer = saved === undefined ? undefined : linkedPeer(saved);

  return peer === undefined ? undefined : { peer, retired: !isPinnedRemote(saved?.gateway.remote) };
}

function retiredFiles(manage: Manage): string {
  return `Old certificate folders (pair-*) in ${visibleText(setupPaths(manage.agentDir).directory)} are no longer used and can be deleted. Setup never deletes key files.`;
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

    return canonical(again.adapter) === canonical(saved.adapter) &&
      canonical(again.gateway) === canonical(saved.gateway)
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
  "Owned config/metadata replaced only by CAS under the setup lock; .previous-* snapshots kept. No key file is replaced or deleted. No blanket /reload, process/PID killing or uncertain-send replay.";

async function keyWork(manage: Manage, step: Step): Promise<Outcome> {
  step(KEY_STEPS[0]);
  const key = await ensureKey(manage.setup.executable, setupPaths(manage.agentDir).directory);

  return {
    ok: true,
    headline: "✓ This computer's key is ready",
    facts: [["Public key", key]],
    next: `Choose Setup › ${LINK_LABEL} to see this key again and enter the other computer's key.`,
  };
}

function keyScreen(manage: Manage, progress: Progress): Screen {
  const { privateKey } = keyPaths(setupPaths(manage.agentDir).directory);

  return actionForm({
    title: "Link",
    note: "Linking needs a key for this computer. Setup creates one private key file and shows its public key, which you enter on the other computer.",
    details: () =>
      withTechnical(
        [
          "Creates this computer's private key, or reads it if it already exists. The private key never leaves this computer.",
          "Nothing else changes and nothing is restarted.",
        ],
        [
          `Key file ${visibleText(privateKey)}: owner-only Ed25519 key in an owner-only folder, created by the gateway's key generate command and reused by key show.`,
        ],
      ),
    detailsDescription: "What creating the key writes.",
    consent: () => ({
      label: "Create key",
      action: "Create key",
      gate: { kind: "ready", value: undefined },
      description: "Create or read this computer's key and show its public key.",
      run: () => {
        progress("Creating the key", KEY_STEPS, async (step) =>
          attempt("Creating the key failed", INCOMPLETE_NEXT, async () => keyWork(manage, step)),
        );
      },
    }),
  });
}

async function linkWork(
  manage: Manage,
  intent: RemoteIntent,
  own: string,
  step: Step,
): Promise<Outcome> {
  step(LINK_STEP);
  const directory = setupPaths(manage.agentDir).directory;

  if ((await ensureKey(manage.setup.executable, directory)) !== own) {
    throw new RefusalError(
      "this computer's key changed since it was shown",
      "Open Setup again to see the current key",
    );
  }

  const plan = linkedPlan(await freshPlan(manage), intent, keyPaths(directory).privateKey);
  const peer = visibleText(intent.peerMachineId);

  return changeWork(
    manage,
    {
      plan,
      failure: "Linking failed",
      done: {
        ok: true,
        headline: `✓ Linked with ${peer}`,
        facts: [
          ["Peer", remoteSummary(intent)],
          ["Peer public key", intent.peerPublicKey],
          ["Public key", own],
        ],
        next: `Enter this computer's public key on ${peer} if you have not yet. Choose Doctor to check the remote link.`,
      },
    },
    step,
  );
}

function linkForm(manage: Manage, own: string, progress: Progress): Screen {
  const link = linkOf(manage);
  const draft = remoteDraft(manage.saved?.gateway.remote);
  const machine = manage.config.machineId;
  const { privateKey } = keyPaths(setupPaths(manage.agentDir).directory);
  const gate = () => remoteGate(draft, machine, own);

  return actionForm({
    title: "Link",
    note: `This computer's public key: ${own}\nEnter it on the other computer in Setup › ${LINK_LABEL}, and enter that computer's key below. Nothing changes until you choose Link.`,
    rows: () => remoteRows(draft, own),
    details: () => {
      const current = gate();

      return withTechnical(
        [
          ...(current.kind === "ready"
            ? remoteReview(current.value, privateKey)
            : [`Link is not ready: ${gateText(current)}`]),
          ...CHANGE_LINES,
          ...(link?.retired === true ? [retiredFiles(manage)] : []),
        ],
        [CHANGE_TECHNICAL],
      );
    },
    detailsDescription: "What linking trusts, changes and restarts.",
    consent: () => ({
      label: "Link",
      action: "Link",
      gate: gate(),
      description: "Save the link, restart the gateway once and reconnect this Pi.",
      run: (intent) => {
        progress("Linking", plannedSteps(manage, [LINK_STEP]), async (step) =>
          attempt("Linking failed", INCOMPLETE_NEXT, async () =>
            linkWork(manage, intent, own, step),
          ),
        );
      },
    }),
  });
}

async function unlinkWork(manage: Manage, peer: string, step: Step): Promise<Outcome> {
  return changeWork(
    manage,
    {
      plan: unlinkedPlan(await freshPlan(manage)),
      failure: "Removing the link failed",
      done: {
        ok: true,
        headline: `✓ Remote link removed — ${visibleText(peer)}`,
        facts: [],
        next: "This computer no longer trusts the other computer's key. Remove the link there too.",
      },
    },
    step,
  );
}

function unlinkForm(manage: Manage, peer: string, progress: Progress): Screen {
  return actionForm({
    title: "Remove link",
    note: `Stop trusting ${visibleText(peer)} and stop listening for or dialling it. Nothing changes until you choose Remove link.`,
    details: () =>
      withTechnical(
        [
          `Removes the remote link and ${visibleText(peer)}'s permissions. Local sessions keep working.`,
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
            unlinkWork(manage, peer, step),
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
      "This Pi reconnects with a fresh identity, so its inbox is lost. Keys and the gateway install are kept.",
      ...(link === undefined
        ? []
        : [`${peerGrantText(link.peer)} Its connection details are kept.`]),
    ],
    [
      ...(plan === undefined ? [] : [localReview(plan, link !== undefined)]),
      `Owned config/metadata replaced only by CAS under the setup lock; .previous-* snapshots kept. Socket ${visibleText(manage.config.socketPath)} unchanged. ${manage.shared ? "Exactly ONE machine-bound shared restart request; an uncertain outcome is never replayed." : "No live shared socket observed; no restart request."} This Pi runtime is replaced only while idle, with a new nonce. No key deletion or send replay.`,
    ],
  );
}

function linkScreen(manage: Manage, progress: Progress): Screen {
  if (manage.upgrade !== undefined) {
    return manage.upgrade(progress);
  }

  return manage.ownKey === undefined
    ? keyScreen(manage, progress)
    : linkForm(manage, manage.ownKey, progress);
}

function linkRows(manage: Manage, progress: Progress): Array<Row> {
  const link = linkOf(manage);

  let description = "Link one other computer by exchanging public keys.";

  if (link !== undefined) {
    description = link.retired
      ? "Link again with keys. This replaces the retired certificates."
      : `Change the link with ${visibleText(link.peer)}, or link another computer instead.`;
  }

  return [
    opener("link", LINK_LABEL, description, () => linkScreen(manage, progress)),
    ...(link === undefined
      ? []
      : [
          opener(
            "unlink",
            "Remove the remote link",
            `Stop trusting ${visibleText(link.peer)}.`,
            () => unlinkForm(manage, link.peer, progress),
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
    ownKey: await savedKey(setupPaths(agentDir).directory).catch(() => undefined),
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
    : `Set up as ${machine}, linked with ${visibleText(link.peer)} by its pinned key. Nothing changes until you choose Apply.`;
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
      "Can't change here: the linked computer knows this machine by name. Remove the remote link to rename it.";
    options.peer = link.peer;
  }

  if (rebuild !== undefined) {
    options.rebuild = rebuild;
  }

  return manageForm(options);
}
