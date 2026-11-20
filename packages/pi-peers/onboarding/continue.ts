import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadConfiguration, visibleText } from "../adapter/config.js";
import type { Configuration } from "../adapter/config.js";
import { readManaged, setupPaths } from "./backend.js";
import { regularBytes } from "./files.js";
import { requestManagedRestart } from "./managed.js";
import type { ManagedSetup } from "./managed.js";
import {
  actionForm,
  hashField,
  missingField,
  opener,
  pathField,
  report,
  textField,
  validated,
  withTechnical,
} from "./menu/forms.js";
import type { Gate, Progress } from "./menu/forms.js";
import type { Row, Screen } from "./menu/model.js";
import type { Outcome, Step } from "./menu/progress.js";
import { remoteDraft, remoteGate, remoteRows } from "./menu/remote-form.js";
import type { RemoteOptions } from "./menu/remote-form.js";
import { attempt, failed, INCOMPLETE_NEXT, pendingOutcome, SAVED_NEXT } from "./outcome.js";
import { credentials, pairAction } from "./pair.js";
import type { PairOperation } from "./pair.js";
import type { LocalChoices, LocalPlan } from "./plan.js";
import { configured, machineError, prepareRemote, remoteReview } from "./remote.js";
import type { RemoteIntent } from "./remote.js";
import type { Reconnect } from "./route.js";
import { decodePairing, decodeGateway, decodeRecord, parseJson } from "./schema.js";
import { saveOwnedPlan } from "./update.js";

export type Pairing = ReturnType<typeof decodePairing>;

const PUBLIC = [
  ["offerPath", "Offer file"],
  ["requestPath", "Request file"],
  ["requestSha256", "Request SHA256"],
  ["bundlePath", "Bundle file"],
  ["rootSha256", "Root SHA256"],
  ["pairId", "Pair ID"],
] as const;

function publicFacts(available: Record<string, unknown>): [string, string][] {
  return PUBLIC.flatMap(([key, label]): [string, string][] => {
    const value = available[key];
    return typeof value === "string" ? [[label, visibleText(value)]] : [];
  });
}

/** The public files and fingerprints to exchange, as outcome facts. */
export function exchangeFacts(pairing: Pairing): [string, string][] {
  return publicFacts({ ...pairing.output, ...pairing.inspection });
}

/** The next exchange step for this side of the pair. */
export function exchangeNext(pairing: Pairing): string {
  return pairing.intent.kind === "create"
    ? "Send the offer file and its root SHA256 to the other computer and confirm the SHA256 with them separately. When their request arrives, choose Setup › Issuer actions › Issue peer CSR."
    : "Send the request file and its SHA256 to the computer that made the pair. When its bundle arrives, choose Setup › Import public bundle.";
}

/** Plain public exchange instructions; internals under Technical details. */
function exchangeLines(pairing: Pairing): string[] {
  return withTechnical(
    [
      `Peer: ${visibleText(pairing.intent.peerMachineId)}. These files are public; never send a private key.`,
      ...exchangeFacts(pairing).map(([label, value]) => `${label}: ${value}`),
      `Next: ${exchangeNext(pairing)}`,
    ],
    [
      pairing.intent.kind === "create"
        ? "After issuance IMPORT the refreshed bundle on BOTH machines (existing floor on creator; new only pending joiner)."
        : "Import the issuer's public bundle with the independently confirmed full root SHA256.",
      ...(pairing.intent.kind === "existing"
        ? [
            "Existing-material issuer custody is not adopted; external renewal requires a signer/bundle matching this runtime's exact offer binding. Arbitrary external-CA renewal is not automated or proven.",
          ]
        : []),
      `Runtime ${pairing.runtimeDir}. No key bytes are exchanged. Renew leaves/CRL and import before expiry; root/account compromise requires re-pair BOTH machines. Local up is not remote-linked proof.`,
    ],
  );
}

/** The saved setup-managed pairing, if any (read-only). */
export async function readPairing(agentDir: string): Promise<Pairing | undefined> {
  const bytes = await regularBytes(join(setupPaths(agentDir).directory, "pairing.json"));
  return bytes === undefined ? undefined : decodePairing(parseJson(bytes));
}

export type PairContext = {
  readonly agentDir: string;
  readonly reconnect: Reconnect | undefined;
  readonly paths: ReturnType<typeof setupPaths>;
  readonly config: Configuration;
  readonly setup: ManagedSetup;
  readonly pairing: Pairing;
};

/** The saved setup-owned pairing and its owned files, or undefined when there is none (read-only). */
export async function loadedPair(
  agentDir: string,
  reconnect: Reconnect | undefined,
): Promise<PairContext | undefined> {
  const pairing = await readPairing(agentDir);
  if (pairing === undefined) {
    return undefined;
  }
  const config = await loadConfiguration(agentDir);
  if (config === undefined) {
    return undefined;
  }
  const setup = await readManaged(agentDir, config);
  if (setup === undefined) {
    return undefined;
  }
  return { agentDir, reconnect, paths: setupPaths(agentDir), config, setup, pairing };
}

type Maintenance = { readonly operation: PairOperation; readonly input: Record<string, unknown> };

const STEPS = [
  "Running the pairing step",
  "Saving and restarting the gateway once",
  "Reconnecting this Pi",
] as const;

async function gatewayPlan(context: PairContext): Promise<LocalPlan> {
  const gatewayBytes = await regularBytes(context.paths.gateway);
  if (gatewayBytes === undefined) {
    throw new Error("Gateway projection missing");
  }
  return currentPlan(context.config, gatewayBytes);
}

async function restartAndReconnect(
  context: PairContext,
  step: Step,
): Promise<"acknowledged" | "uncertain"> {
  let restart = await requestManagedRestart(context.setup);
  step(STEPS[2]);
  try {
    await context.reconnect?.(true);
  } catch {
    restart = "uncertain";
  }
  return restart;
}

async function maintain(context: PairContext, action: Maintenance, step: Step): Promise<Outcome> {
  const { setup, paths, pairing, agentDir } = context;
  const { operation, input } = action;
  step(STEPS[0]);
  let output: Record<string, unknown> = {};
  try {
    const prepared =
      operation === "import"
        ? { ...input, floorMode: await importFloor(pairing.runtimeDir) }
        : input;
    output = await pairAction(setup.executable, paths.directory, operation, prepared);
  } catch {
    return failed(
      `Pairing ${operation} failed`,
      "the files or fingerprint were not accepted",
      "Check the file paths and fingerprint, then try again.",
    );
  }
  const facts = publicFacts(output);
  const technical = [`Pair ${operation} output (public files only): ${JSON.stringify(output)}`];
  if (operation === "export") {
    return {
      ok: true,
      headline: "✓ Public bundle exported",
      facts,
      next: "Send the bundle file to the other computer. It imports it with the root SHA256 confirmed separately.",
      technical,
    };
  }
  let saved = false;
  try {
    const imported =
      operation === "import"
        ? output
        : await pairAction(setup.executable, paths.directory, "import", {
            runtimeDir: pairing.runtimeDir,
            bundlePath: output.bundlePath,
            confirmedRootSha256: output.rootSha256,
            floorMode: "existing",
          });
    step(STEPS[1]);
    const old = await gatewayPlan(context);
    const inspection = await pairAction(setup.executable, paths.directory, "inspect", {
      runtimeDir: pairing.runtimeDir,
    });
    await saveOwnedPlan(
      agentDir,
      setup,
      configured(old, pairing.intent, credentials(imported)),
      JSON.stringify({ ...pairing, inspection }),
    );
    saved = true;
    const restart = await restartAndReconnect(context, step);
    if (restart === "uncertain") {
      return pendingOutcome(`Pairing ${operation} saved`, SAVED_NEXT, [
        ...technical,
        "The gateway restart was not confirmed.",
      ]);
    }
  } catch {
    return saved
      ? pendingOutcome(`Pairing ${operation} saved`, SAVED_NEXT, technical)
      : {
          ...failed(
            `Pairing ${operation} failed`,
            "the new keys could not be saved",
            INCOMPLETE_NEXT,
            technical,
          ),
          facts,
        };
  }
  return {
    ok: true,
    headline: `✓ Pairing ${operation} done`,
    facts,
    next:
      operation === "import"
        ? "This computer now trusts the new bundle. Choose Doctor to check the remote link."
        : "Send the bundle file to the other computer. It imports it with the root SHA256 confirmed separately.",
    technical,
  };
}

function maintenanceDetails(context: PairContext, operation: PairOperation): string[] {
  const activates = operation !== "export";
  return withTechnical(
    [
      activates
        ? "Updates this computer's pair files, saves the settings, restarts the shared gateway once and reconnects this Pi. Other sessions briefly disconnect."
        : "Exports the latest public bundle. Nothing else changes.",
      `Peer: ${visibleText(context.pairing.intent.peerMachineId)}. Private keys never enter this menu.`,
    ],
    [
      `Pair ${operation}: private bounded CLI input file; issuer key only used by explicit issue/renew/revoke, never gateway runtime. Root 365 days, leaves 90 days, complete CRL 30 days. ${activates ? "This Apply includes native stage/import of OWN refreshed public bundle, owned config/metadata CAS, and exactly one managed restart request. Existing floors are checked without rollback, then durably applied at remote activation. Unknown restart ACK is checked by reconnect, not replayed." : "Export only returns current public bundle without changing validity, credentials, floors or gateway."} Root/account compromise requires re-pair BOTH machines. No process/PID killing, private key/floor deletion, hot reload, or automatic send replay.`,
      ...(operation === "revoke"
        ? ["Revokes ALL issued peer serials in the activated local CRL."]
        : []),
    ],
  );
}

type MaintenanceForm = {
  readonly title: string;
  readonly note: string;
  readonly operation: PairOperation;
  readonly label: string;
  readonly rows?: () => readonly Row[];
  readonly gate: () => Gate<Maintenance>;
};

function maintenanceForm(context: PairContext, progress: Progress, form: MaintenanceForm): Screen {
  return actionForm({
    title: form.title,
    note: form.note,
    ...(form.rows === undefined ? {} : { rows: form.rows }),
    details: () => maintenanceDetails(context, form.operation),
    detailsDescription: "What this pairing step changes and restarts.",
    consent: () => ({
      label: form.label,
      action: "Apply",
      gate: form.gate(),
      description:
        form.operation === "export"
          ? "Export the public bundle."
          : "Run this step, restart the gateway once and reconnect.",
      run: (action) => {
        progress(form.title, STEPS, async (step) =>
          attempt(`Pairing ${form.operation} failed`, INCOMPLETE_NEXT, async () =>
            maintain(context, action, step),
          ),
        );
      },
    }),
  });
}

function importForm(context: PairContext, progress: Progress): Screen {
  const draft = { path: "", sha: "" };
  return maintenanceForm(context, progress, {
    title: "Import",
    note: "Import the public bundle the other computer sent. Confirm its root SHA256 with them separately.",
    operation: "import",
    label: "Import bundle",
    rows: () => [
      pathField(
        "bundlePath",
        "Bundle file",
        "The public bundle file from the issuer.",
        {
          get: () => draft.path,
          set: (value) => {
            draft.path = value;
          },
        },
        "/path/to/bundle.json",
      ),
      hashField(
        "rootSha256",
        "Root SHA256",
        "The full root fingerprint, confirmed separately; never trust a checksum sent next to the file.",
        {
          get: () => draft.sha,
          set: (value) => {
            draft.sha = value;
          },
        },
      ),
    ],
    gate: () =>
      missingField([
        ["Bundle file", draft.path],
        ["Root SHA256", draft.sha],
      ]) ?? {
        kind: "ready",
        value: {
          operation: "import",
          input: {
            runtimeDir: context.pairing.runtimeDir,
            bundlePath: draft.path,
            confirmedRootSha256: draft.sha,
          },
        },
      },
  });
}

function requestForm(context: PairContext, progress: Progress, initial: boolean): Screen {
  const draft = { path: "", sha: "" };
  const operation = initial ? "issue" : "renew";
  return maintenanceForm(context, progress, {
    title: initial ? "Issue" : "Renew",
    note: initial
      ? "Issue the peer's certificate from its public request file."
      : "Renew both computers' certificates and the revocation list from the peer's public request.",
    operation,
    label: initial ? "Issue certificate" : "Renew certificates",
    rows: () => [
      pathField(
        "requestPath",
        "Request file",
        "The peer's public request file. Its private key never leaves it.",
        {
          get: () => draft.path,
          set: (value) => {
            draft.path = value;
          },
        },
        "/path/to/request.json",
      ),
      hashField(
        "requestSha256",
        "Request SHA256",
        "The request's full SHA256, confirmed separately.",
        {
          get: () => draft.sha,
          set: (value) => {
            draft.sha = value;
          },
        },
      ),
    ],
    gate: () =>
      missingField([
        ["Request file", draft.path],
        ["Request SHA256", draft.sha],
      ]) ?? {
        kind: "ready",
        value: {
          operation,
          input: {
            issuerDir: context.pairing.issuerDir,
            requestPath: draft.path,
            confirmedRequestSha256: draft.sha,
          },
        },
      },
  });
}

function revokeForm(context: PairContext, progress: Progress): Screen {
  const peer = context.pairing.intent.peerMachineId;
  const draft = { machine: peer };
  return maintenanceForm(context, progress, {
    title: "Revoke",
    note: "Revoke every certificate issued to the peer. If a root or account was compromised, re-pair both computers instead.",
    operation: "revoke",
    label: "Revoke peer",
    rows: () => [
      textField({
        id: "machine",
        label: "Machine",
        description: "The paired peer to revoke.",
        placeholder: peer,
        get: () => draft.machine,
        save: validated(machineError, (value) => {
          draft.machine = value;
        }),
      }),
    ],
    gate: (): Gate<Maintenance> => {
      if (draft.machine === context.config.machineId) {
        return { kind: "invalid", reason: "to replace this computer's keys, re-pair instead" };
      }
      if (draft.machine !== peer) {
        return { kind: "invalid", reason: `choose the paired peer ${visibleText(peer)}` };
      }
      return {
        kind: "ready",
        value: {
          operation: "revoke",
          input: { issuerDir: context.pairing.issuerDir, machineId: draft.machine },
        },
      };
    },
  });
}

function issuerMenu(context: PairContext, progress: Progress): Screen {
  return {
    kind: "list",
    title: "Issuer",
    note: "This computer made the pair, so it issues certificates. Each step is reviewed before it runs.",
    rows: () => [
      opener("issue", "Issue peer CSR", "Issue the peer's certificate from its request.", () =>
        requestForm(context, progress, true),
      ),
      opener("renew", "Renew leaves and CRL", "Renew certificates before they expire.", () =>
        requestForm(context, progress, false),
      ),
      opener("revoke", "Revoke a leaf", "Stop trusting the peer's certificates.", () =>
        revokeForm(context, progress),
      ),
      opener("export", "Export latest public bundle", "Write the current public bundle.", () =>
        maintenanceForm(context, progress, {
          title: "Export",
          note: "Export the latest public bundle for the peer. Nothing else changes.",
          operation: "export",
          label: "Export bundle",
          gate: () => ({
            kind: "ready",
            value: { operation: "export", input: { issuerDir: context.pairing.issuerDir } },
          }),
        }),
      ),
    ],
  };
}

const REPAIR_STEPS = [
  "Creating the new pair",
  "Saving and restarting the gateway once",
  "Reconnecting this Pi",
] as const;

async function rePairWork(
  context: PairContext,
  intent: RemoteIntent,
  directory: string,
  step: Step,
): Promise<Outcome> {
  const { setup, agentDir } = context;
  step(REPAIR_STEPS[0]);
  const old = await gatewayPlan(context);
  const next = await prepareRemote(setup.executable, directory, old, intent);
  const manifest = await regularBytes(join(directory, "pairing.json"));
  if (manifest === undefined) {
    throw new Error("New pairing manifest missing");
  }
  step(REPAIR_STEPS[1]);
  await saveOwnedPlan(agentDir, setup, next, manifest.toString("utf8"));
  const restart = await restartAndReconnect(context, step);
  const pairing = decodePairing(parseJson(manifest));
  return {
    ok: true,
    headline: `✓ New pair staged with ${visibleText(intent.peerMachineId)}`,
    facts: exchangeFacts(pairing),
    next: exchangeNext(pairing),
    technical: [
      `New trust staged; restart ${restart}. Old issuer/keys/floors remain untouched. Remote link readiness remains unverified.`,
    ],
  };
}

function rePairForm(context: PairContext, progress: Progress): Screen {
  const { pairing, paths, config } = context;
  const peer = pairing.intent.peerMachineId;
  const root = oldRoot(pairing);
  const options: RemoteOptions = {
    kinds: ["create", "join"],
    peer,
    ...(root === undefined ? {} : { oldRoot: root }),
  };
  const draft = remoteDraft();
  draft.peer = peer;
  const directory = join(paths.directory, `re-pair-${randomBytes(12).toString("hex")}`);
  return actionForm({
    title: "Re-pair",
    note: "Replace this pair's trust with a new root. Both computers re-pair; old keys and floors are kept.",
    rows: () => remoteRows(draft, options),
    details: () => {
      const gate = remoteGate(draft, config.machineId, options);
      return withTechnical(
        [
          "Creates or joins a new pair for the same two computers, saves it, restarts the shared gateway once and reconnects this Pi.",
          "Current remote trust is replaced only by this Apply. Old keys and floors stay on disk.",
        ],
        [
          `Custody: ${directory}. Same-account compromise is not isolated by directories.`,
          ...(gate.kind === "ready" ? [remoteReview(gate.value, directory)] : []),
        ],
      );
    },
    consent: () => ({
      label: "Re-pair",
      action: "Apply",
      gate: remoteGate(draft, config.machineId, options),
      description: "Create the new pair trust and restart the shared gateway once.",
      run: (intent) => {
        progress("Re-pairing", REPAIR_STEPS, async (step) =>
          attempt("Re-pair failed", INCOMPLETE_NEXT, async () =>
            rePairWork(context, intent, directory, step),
          ),
        );
      },
    }),
  });
}

function oldRoot(pairing: Pairing): string | undefined {
  const root = pairing.output.rootSha256;
  return typeof root === "string"
    ? root
    : (pairing.intent.confirmedRootSha256 ?? pairing.intent.existing?.confirmedRootSha256);
}

function renewalLines(pairing: Pairing): string[] {
  return withTechnical(
    [
      `Send the request file ${visibleText(join(pairing.runtimeDir, "request.json"))} and its SHA256 to the computer that made the pair.`,
      "It renews both computers' certificates. Then choose Import public bundle here, with its root SHA256 confirmed separately.",
    ],
    [
      ...(pairing.intent.kind === "existing"
        ? [
            "Existing-material CA/issuer custody is NOT adopted. Its signer must accept this runtime's exact pair/offer binding; arbitrary external CA renewal is not automated or proven by this setup.",
          ]
        : []),
      "Do not send leaf/issuer private keys. Missing existing floors are never recreated.",
    ],
  );
}

/**
 * The rows for a verified setup-owned pairing: exchange instructions, import, issuer or renewal
 * help, and re-pair. Each action is its own screen with one consent row.
 */
export function pairRows(context: PairContext, progress: Progress): Row[] {
  const { pairing } = context;
  return [
    opener(
      "instructions",
      "View public exchange instructions",
      "Which public files to send, and what comes next.",
      () => report("Exchange", () => exchangeLines(pairing)),
    ),
    opener("import", "Import public bundle", "Import the bundle the other computer sent.", () =>
      importForm(context, progress),
    ),
    pairing.intent.kind === "create"
      ? opener("issuer", "Issuer actions", "Issue, renew, revoke or export certificates.", () =>
          issuerMenu(context, progress),
        )
      : opener("renewal", "Request renewal instructions", "How to renew before expiry.", () =>
          report("Renewal", () => renewalLines(pairing)),
        ),
    opener(
      "re-pair",
      "Re-pair with new root",
      "Replace this pair's trust, for example after a compromise.",
      () => rePairForm(context, progress),
    ),
  ];
}

/** The saved Machine, Scope, Label and Permissions of a configuration. */
export function savedChoices(config: Configuration): LocalChoices {
  const scopeId = config.scopeIds[0];
  if (scopeId === undefined) {
    throw new Error("No configured scope");
  }
  const permissions =
    config.policies.find(
      (grant) => grant.machineId === config.machineId && grant.scopeId === scopeId,
    )?.permissions ?? [];
  return { machineId: config.machineId, scopeId, label: config.label, permissions };
}

/** The saved plan, rebuilt from the saved configuration and gateway projection. */
export function currentPlan(config: Configuration, gatewayBytes: Buffer): LocalPlan {
  return {
    choices: savedChoices(config),
    adapter: config,
    gateway: decodeGateway(parseJson(gatewayBytes)),
  };
}

/** Floor mode for an import: an installed runtime keeps its existing floor. */
async function importFloor(runtimeDir: string): Promise<"existing" | "new"> {
  const runtimeBytes = await regularBytes(join(runtimeDir, "runtime.json"));
  if (runtimeBytes === undefined) {
    throw new Error("Existing pairing state missing; floors are never silently recreated");
  }
  return decodeRecord(parseJson(runtimeBytes)).installed === true ? "existing" : "new";
}
