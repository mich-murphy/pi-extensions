import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Schema } from "effect";
import { loadConfiguration, visibleText } from "../adapter/config.js";
import type { Configuration } from "../adapter/config.js";
import { stableValue } from "../protocol/identity.js";
import { activationScreen } from "./activation.js";
import { inspectSetup, readManaged, setupPaths } from "./backend.js";
import {
  currentPlan,
  exchangeFacts,
  exchangeNext,
  loadedPair,
  pairRows,
  savedChoices,
} from "./continue.js";
import type { PairContext } from "./continue.js";
import { regularBytes } from "./files.js";
import { requestManagedRestart } from "./managed.js";
import type { ManagedSetup } from "./managed.js";
import { actionForm, opener, withTechnical } from "./menu/forms.js";
import type { Progress } from "./menu/forms.js";
import type { Row, Screen } from "./menu/model.js";
import type { Outcome, Step } from "./menu/progress.js";
import { remoteDraft, remoteGate, remoteRows } from "./menu/remote-form.js";
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
import { localPlan, localReview } from "./plan.js";
import type { LocalChoices, LocalPlan } from "./plan.js";
import { SETTINGS_CHANGED } from "./refusal.js";
import { keptPair, prepareRemote, remoteReview } from "./remote.js";
import type { RemoteIntent } from "./remote.js";
import type { ActivatePlan, Reconnect, Restart } from "./route.js";
import { decodePairing, parseJson } from "./schema.js";
import { saveOwnedPlan } from "./update.js";

export type { ActivatePlan } from "./route.js";

const RECONNECT_STEPS = ["Reconnecting this Pi"] as const;

const ADD_STEPS = [
  "Creating the pair",
  "Saving and restarting the gateway once",
  "Replacing this Pi's connection",
] as const;

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

type Upgrade = Pick<Manage, "agentDir" | "setup" | "activate">;

async function addWork(
  upgrade: Upgrade,
  intent: RemoteIntent,
  directory: string,
  step: Step,
): Promise<Outcome> {
  const { agentDir, setup, activate } = upgrade;
  const paths = setupPaths(agentDir);
  step(ADD_STEPS[0]);
  const config = await loadConfiguration(agentDir);
  const bytes = await regularBytes(paths.gateway);

  if (config === undefined || bytes === undefined) {
    throw SETTINGS_CHANGED();
  }

  const next = await prepareRemote(setup.executable, directory, currentPlan(config, bytes), intent);
  const pairing = await regularBytes(join(directory, "pairing.json"));

  if (pairing === undefined) {
    throw new Error("The pairing step did not write pairing.json");
  }

  step(ADD_STEPS[1]);
  await saveOwnedPlan(agentDir, setup, next, pairing.toString("utf8"), true);
  const restart = await requestManagedRestart(setup);

  const technical = [
    `Remote addition saved; shared restart ${restart}; local connection is separate from remote link readiness.`,
  ];

  step(ADD_STEPS[2]);

  try {
    const updated = await readManaged(agentDir, next.adapter);

    if (updated === undefined) {
      throw new Error("The updated setup record is missing");
    }

    await activate(next, updated, true);
  } catch (error) {
    return afterSave(error instanceof Error ? error : undefined, technical);
  }

  const saved = decodePairing(parseJson(pairing));

  return {
    ok: true,
    headline: `✓ Remote peer added — ${visibleText(intent.peerMachineId)}`,
    facts: exchangeFacts(saved),
    next: exchangeNext(saved),
    technical: [...technical, "This Pi runtime explicitly replaced."],
  };
}

function addForm(upgrade: Upgrade, machine: string, progress: Progress): Screen {
  const draft = remoteDraft();

  const directory = join(
    setupPaths(upgrade.agentDir).directory,
    `pair-${randomBytes(12).toString("hex")}`,
  );

  return actionForm({
    title: "Add peer",
    note: `Link one other computer to ${visibleText(machine)}. Nothing changes until you choose Add peer.`,
    rows: () => remoteRows(draft),
    details: () => {
      const gate = remoteGate(draft, machine);

      return withTechnical(
        [
          "Applies to every project on this account. Peer messages may wake the model, which costs provider usage.",
          "This Pi reconnects with a fresh identity, so its inbox is lost. Other open sessions keep their old grants until they restart.",
          "The shared gateway restarts once; nothing is resent.",
        ],
        [
          ...(gate.kind === "ready" ? [remoteReview(gate.value, directory)] : []),
          `Preserve machine identity/scopes/local grants. Reuse hash-verified setup executable. Write fresh pair generation; CAS only unchanged owned config/metadata. Explicitly replace this Pi runtime only while idle, with new nonce. No blanket /reload, process/PID killing, credential/revocation record deletion or uncertain-send replay.`,
        ],
      );
    },
    consent: () => ({
      label: "Add peer",
      action: "Apply",
      gate: remoteGate(draft, machine),
      description: "Add the peer, restart the gateway once and replace this Pi's connection.",
      run: (intent) => {
        progress("Adding", ADD_STEPS, async (step) =>
          attempt("Adding the peer failed", INCOMPLETE_NEXT, async () =>
            addWork(upgrade, intent, directory, step),
          ),
        );
      },
    }),
  });
}

const EDIT_STEPS = [
  "Saving the settings",
  "Restarting the shared gateway once",
  "Reconnecting this Pi",
] as const;

type Manage = {
  readonly agentDir: string;
  readonly config: Configuration;
  readonly setup: ManagedSetup;
  readonly activate: ActivatePlan;
  readonly reconnect: Reconnect | undefined;
  readonly restart: Restart;
  readonly pair: PairContext | undefined;
  shared: boolean;
};

function canonical(value: Schema.Json): string {
  return JSON.stringify(stableValue(value));
}

async function rebuilder(
  manage: Manage,
): Promise<((choices: LocalChoices) => LocalPlan) | undefined> {
  const { config, pair } = manage;

  try {
    const bytes = await regularBytes(setupPaths(manage.agentDir).gateway);

    if (bytes === undefined) {
      return undefined;
    }

    const saved = currentPlan(config, bytes);

    const rebuild = (choices: LocalChoices): LocalPlan => {
      const local = localPlan(choices, config.socketPath);

      return pair === undefined
        ? local
        : keptPair(local, pair.pairing.intent, saved.gateway.remote);
    };

    const again = rebuild(saved.choices);

    return canonical(again.adapter) === canonical(saved.adapter) &&
      canonical(again.gateway) === canonical(saved.gateway)
      ? rebuild
      : undefined;
  } catch {
    return undefined;
  }
}

function changed(plan: LocalPlan): [string, string][] {
  return [
    ["Machine", visibleText(plan.choices.machineId)],
    ["Scope", visibleText(plan.choices.scopeId)],
    ["Label", visibleText(plan.choices.label)],
    ["Permissions", plan.choices.permissions.join(", ") || "none"],
  ];
}

const EDIT_PENDING_NEXT =
  "Choose Setup › Activate saved configuration, or start a new Pi session to use the saved settings.";

async function editWork(manage: Manage, plan: LocalPlan, step: Step): Promise<Outcome> {
  const { agentDir, setup, activate } = manage;
  step(EDIT_STEPS[0]);
  const observed = await inspectSetup(agentDir, setup.socketPath);

  if (observed.sharedInstance !== manage.shared) {
    manage.shared = observed.sharedInstance;

    return failed("Changing settings failed", GATEWAY_CHANGED, REVIEW_AGAIN);
  }

  await saveOwnedPlan(agentDir, setup, plan, undefined, true);

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
    ok: true,
    headline: `✓ Settings changed — connected as ${visibleText(plan.adapter.machineId)}`,
    facts: changed(plan),
    next: "Other open Pi sessions keep the old settings until they restart.",
    technical: [...technical, "This Pi runtime explicitly replaced while idle."],
  };
}

function editDetails(manage: Manage, plan: LocalPlan | undefined): string[] {
  return withTechnical(
    [
      "Applies to every project on this account. Peer messages may wake the model, which costs provider usage.",
      manage.shared
        ? "Apply saves the changes, restarts the shared gateway once and reconnects this Pi. Other sessions briefly disconnect and keep the old settings until they restart."
        : "Apply saves the changes and connects this Pi with them. Other sessions keep the old settings until they restart.",
      "This Pi reconnects with a fresh identity, so its inbox is lost. Keys, pair files and the gateway install are kept.",
      ...(manage.pair === undefined
        ? []
        : [
            `${peerGrantText(manage.pair.pairing.intent.peerMachineId)} Its connection details are kept.`,
          ]),
    ],
    [
      ...(plan === undefined ? [] : [localReview(plan, manage.pair !== undefined)]),
      `Owned config/metadata replaced only by CAS under the setup lock; .previous-* snapshots kept. Socket ${visibleText(manage.config.socketPath)} unchanged. ${manage.shared ? "Exactly ONE machine-bound shared restart request; an uncertain outcome is never replayed." : "No live shared socket observed; no restart request."} This Pi runtime is replaced only while idle, with a new nonce. No credential/revocation record deletion or send replay.`,
    ],
  );
}

function actionRows(manage: Manage, progress: Progress): Row[] {
  const { setup, reconnect, pair } = manage;

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
    ...(pair === undefined
      ? [
          opener("add", "Add one remote peer", "Link one other computer.", () =>
            addForm(manage, manage.config.machineId, progress),
          ),
        ]
      : pairRows(pair, progress)),
  ];
}

export async function manageRoute(
  agentDir: string,
  activate: ActivatePlan,
  reconnect: Reconnect | undefined,
  restart: Restart = requestManagedRestart,
): Promise<((progress: Progress) => Screen) | undefined> {
  const config = await loadConfiguration(agentDir);

  if (config === undefined) {
    return undefined;
  }

  const setup = await readManaged(agentDir, config);

  if (setup === undefined) {
    return undefined;
  }

  const pair = await loadedPair(agentDir, reconnect);
  const observed = await inspectSetup(agentDir, setup.socketPath);

  const manage: Manage = {
    agentDir,
    config,
    setup,
    activate,
    reconnect,
    restart,
    pair,
    shared: observed.sharedInstance,
  };

  const rebuild = await rebuilder(manage);

  return (progress) => manageScreen(manage, rebuild, progress);
}

function manageScreen(
  manage: Manage,
  rebuild: ManageFormOptions["rebuild"],
  progress: Progress,
): Screen {
  const { config, pair } = manage;
  const machine = visibleText(config.machineId);

  const options: ManageFormOptions = {
    saved: savedChoices(config),
    note:
      pair === undefined
        ? `Peers is set up on this computer as ${machine}. Nothing changes until you choose Apply.`
        : `Set up as ${machine}, paired with ${visibleText(pair.pairing.intent.peerMachineId)}. Nothing changes until you choose Apply.`,
    shared: () => manage.shared,
    details: (plan) => editDetails(manage, plan),
    apply: (plan) => {
      progress(
        "Applying",
        manage.shared ? EDIT_STEPS : [EDIT_STEPS[0], EDIT_STEPS[2]],
        async (step) =>
          attempt("Changing settings failed", INCOMPLETE_NEXT, async () =>
            editWork(manage, plan, step),
          ),
      );
    },
    actions: () => actionRows(manage, progress),
  };

  if (pair !== undefined) {
    options.fixedMachine =
      "Can't change here: the pair's certificates name this machine. Re-pair or Reset to rename it.";
    options.peer = pair.pairing.intent.peerMachineId;
  }

  if (rebuild !== undefined) {
    options.rebuild = rebuild;
  }

  return manageForm(options);
}
