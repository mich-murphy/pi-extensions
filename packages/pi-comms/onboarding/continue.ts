import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { loadConfiguration } from "../adapter/config.js";
import { activateSavedConfiguration } from "./activation.js";
import { readManaged, setupPaths } from "./backend.js";
import type { DialogContext } from "./dialog.js";
import { inputChoice, selectChoice, reviewAction } from "./dialog.js";
import { regularBytes } from "./files.js";
import { requestManagedRestart } from "./managed.js";
import { credentials, pairAction } from "./pair.js";
import type { PairOperation } from "./pair.js";
import type { LocalPlan } from "./plan.js";
import { configured, remoteIntent, prepareRemote } from "./remote.js";
import { decodePairing, decodeGateway, decodeRecord, parseJson } from "./schema.js";
import { saveOwnedPlan } from "./update.js";

/** Resume only verified setup-owned pairing; each explicit action has one Apply. */
export async function continuePair(
  agentDir: string,
  ctx: DialogContext,
  reconnect?: (fresh?: boolean) => Promise<void>,
): Promise<boolean> {
  const context = await loadedPair(agentDir, ctx, reconnect);
  if (context === undefined) {
    return false;
  }
  const action = await selectPair(context);
  if (action === undefined || action.startsWith("Cancel")) {
    return true;
  }
  if (action === "Activate saved configuration") {
    await activateSavedConfiguration(context.setup, ctx, reconnect);
    return true;
  }
  if (await information(context, action)) {
    return true;
  }
  if (action === "Re-pair with new root") {
    await rePair(context);
    return true;
  }
  const proposed = await collectAction(context, action);
  if (proposed !== undefined && (await reviewMaintenance(context, proposed.operation))) {
    await applyMaintenance(context, proposed);
  }
  return true;
}
async function loadedPair(
  agentDir: string,
  ctx: DialogContext,
  reconnect?: (fresh?: boolean) => Promise<void>,
) {
  const paths = setupPaths(agentDir);
  const saved = await regularBytes(join(paths.directory, "pairing.json"));
  if (saved === undefined) {
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
  const pairing = decodePairing(parseJson(saved));
  return { agentDir, ctx, reconnect, paths, config, setup, pairing };
}
type PairContext = NonNullable<Awaited<ReturnType<typeof loadedPair>>>;
async function selectPair({ ctx, pairing }: PairContext) {
  return selectChoice(
    ctx,
    `One peer: ${pairing.intent.peerMachineId}. Local up ≠ remote linked.\nExchange PUBLIC offer → CSR → bundle; confirm full SHA256 separately.\nUse public instructions for exact paths/fingerprints; never paste keys.`,
    [
      "Cancel — no changes",
      "View public exchange instructions",
      "Activate saved configuration",
      "Import public bundle",
      ...(pairing.intent.kind === "create"
        ? ["Issue peer CSR", "Renew leaves and CRL", "Revoke a leaf", "Export latest public bundle"]
        : ["Request renewal instructions"]),
      "Re-pair with new root",
    ],
  );
}
async function information(
  { ctx, pairing, agentDir }: PairContext,
  action: string,
): Promise<boolean> {
  if (action === "View public exchange instructions") {
    ctx.ui.notify(await pairingInstructions(agentDir), "info");
    return true;
  }
  if (action === "Request renewal instructions") {
    ctx.ui.notify(
      `${pairing.intent.kind === "existing" ? "Existing-material CA/issuer custody is NOT adopted. Its signer must accept this runtime's exact pair/offer binding; arbitrary external CA renewal is not automated or proven by this setup. " : ""}Send ${join(pairing.runtimeDir, "request.json")} and its independently authenticated full SHA256 to the pair initiator. The initiator renews both leaves/CRL; import its public bundle with full independent root confirmation here. Do not send leaf/issuer private keys. Missing existing floors are never recreated.`,
      "info",
    );
    return true;
  }
  return false;
}
async function rePair({
  ctx,
  pairing,
  paths,
  config,
  setup,
  agentDir,
  reconnect,
}: PairContext): Promise<void> {
  const intent = await remoteIntent(ctx);
  if (intent === undefined) {
    return;
  }
  if (intent.localMachineId !== undefined && intent.localMachineId !== config.machineId) {
    throw new Error(
      "Offer targets another machine identity; existing identity and remote trust are preserved. Use the correct offer/profile.",
    );
  }
  if (intent.kind === "existing" || intent.peerMachineId !== pairing.intent.peerMachineId) {
    throw new Error(
      "Re-pair uses a NEW create/join root for the SAME two reviewed machine identities; existing-material/peer migration needs a separate profile",
    );
  }
  const oldRoot =
    pairing.output.rootSha256 ??
    pairing.intent.confirmedRootSha256 ??
    pairing.intent.existing?.confirmedRootSha256;
  if (intent.kind === "join" && intent.confirmedRootSha256 === oldRoot) {
    throw new Error(
      "Re-pair requires a different independently confirmed root, not the old potentially compromised offer",
    );
  }
  const directory = join(paths.directory, `re-pair-${randomBytes(12).toString("hex")}`);
  const consent = await selectChoice(
    ctx,
    `Re-pair BOTH machines with a new pair-specific root. Old issuer/keys/floors remain untouched. Current remote trust is replaced only after explicit Apply. Shared gateway restart briefly interrupts participants, preserving Pi nonce/state.\nCustody: ${directory}\n${intent.kind} / ${intent.endpoint.mode} ${intent.endpoint.address}. Same-account compromise is not isolated by directories.`,
    ["Cancel — no changes", "Apply — create fresh pair trust and restart shared gateway"],
  );
  if (consent !== "Apply — create fresh pair trust and restart shared gateway") {
    return;
  }
  const gatewayBytes = await regularBytes(paths.gateway);
  if (gatewayBytes === undefined) {
    throw new Error("Gateway projection missing");
  }
  const old = currentPlan(config, gatewayBytes);
  const next = await prepareRemote(setup.executable, directory, old, intent);
  const manifest = await regularBytes(join(directory, "pairing.json"));
  if (manifest === undefined) {
    throw new Error("New pairing manifest missing");
  }
  await saveOwnedPlan(agentDir, setup, next, manifest.toString("utf8"));
  const restart = await requestManagedRestart(setup);
  try {
    await reconnect?.(true);
  } catch {
    /* Report local/remote separately below; no control replay. */
  }
  ctx.ui.notify(
    `New trust staged; restart ${restart}. ${await pairingInstructions(agentDir)} Remote link readiness remains unverified.`,
    "info",
  );
}
async function collectAction(context: PairContext, action: string) {
  if (action === "Import public bundle") {
    return importAction(context);
  }
  if (action === "Issue peer CSR" || action === "Renew leaves and CRL") {
    return issueAction(context, action === "Issue peer CSR");
  }
  if (action === "Revoke a leaf") {
    return revokeAction(context);
  }
  return { operation: "export" as const, input: { issuerDir: context.pairing.issuerDir } };
}
async function importAction({ ctx, pairing }: PairContext) {
  const bundlePath = await inputChoice(
    ctx,
    "Absolute PUBLIC bundle path from issuer",
    "/path/to/bundle.json",
  );
  const fingerprint = await inputChoice(
    ctx,
    "Independently confirmed full root SHA256 (64 lowercase hex); never trust an adjacent checksum alone",
    "full root SHA256",
  );
  if (bundlePath === undefined || fingerprint === undefined) {
    return undefined;
  }
  if (!isAbsolute(bundlePath) || !/^[a-f0-9]{64}$/u.test(fingerprint)) {
    throw new Error("Absolute bundle path and full independently confirmed root SHA256 required");
  }
  const runtimeBytes = await regularBytes(join(pairing.runtimeDir, "runtime.json"));
  if (runtimeBytes === undefined) {
    throw new Error("Existing pairing state missing; floors are never silently recreated");
  }
  const runtime = decodeRecord(parseJson(runtimeBytes));
  return {
    operation: "import" as const,
    input: {
      runtimeDir: pairing.runtimeDir,
      bundlePath,
      confirmedRootSha256: fingerprint,
      floorMode: runtime.installed === true ? "existing" : "new",
    },
  };
}
async function issueAction({ ctx, pairing }: PairContext, initial: boolean) {
  const requestPath = await inputChoice(
    ctx,
    "Absolute PUBLIC CSR/request file path from peer (local private key never exchanged)",
    "/path/to/request.json",
  );
  const confirmedRequestSha256 = await inputChoice(
    ctx,
    "Independently confirm full SHA256 of the peer's public request file",
    "64 lowercase hex characters",
  );
  if (requestPath === undefined || confirmedRequestSha256 === undefined) {
    return undefined;
  }
  if (!isAbsolute(requestPath) || !/^[a-f0-9]{64}$/u.test(confirmedRequestSha256)) {
    throw new Error("Absolute request path and independent full SHA256 required");
  }
  return {
    operation: initial ? ("issue" as const) : ("renew" as const),
    input: { issuerDir: pairing.issuerDir, requestPath, confirmedRequestSha256 },
  };
}
async function revokeAction({ ctx, pairing, config }: PairContext) {
  const machineId = await inputChoice(
    ctx,
    "Exact bound machine to revoke (all issued serials). Root/account compromise instead requires re-pairing BOTH machines.",
    pairing.intent.peerMachineId,
  );
  if (machineId === undefined) {
    return undefined;
  }
  if (machineId === config.machineId) {
    ctx.ui.notify(
      "Self-revocation requires explicit disable/re-pair of both machines; choose Re-pair with new root. No issuer/runtime files changed.",
      "warning",
    );
    return undefined;
  }
  if (machineId !== config.machineId && machineId !== pairing.intent.peerMachineId) {
    throw new Error("Revocation target must be one of the exact bound pair");
  }
  return { operation: "revoke" as const, input: { issuerDir: pairing.issuerDir, machineId } };
}

async function reviewMaintenance({ ctx, pairing }: PairContext, operation: PairOperation) {
  const activates = operation !== "export";
  return reviewAction(
    ctx,
    `Pair ${operation}: ${pairing.intent.peerMachineId}\n${activates ? "Stage own refreshed credentials; restart shared gateway.\nBrief interruption; preserve Pi nonce/state, no send replay." : "Export latest PUBLIC bundle; no issuance/restart."}\n${operation === "revoke" ? "Revoke ALL issued peer serials in the activated local CRL." : "Peer must separately import the PUBLIC bundle."}\nPrivate keys never enter UI; retained floors never reset.`,
    `Pair ${operation}: private bounded CLI input file; issuer key only used by explicit issue/renew/revoke, never gateway runtime. Root 365 days, leaves 90 days, complete CRL 30 days. ${activates ? "This Apply includes native stage/import of OWN refreshed public bundle, owned config/metadata CAS, and exactly one managed restart request. Existing floors are checked without rollback, then durably applied at remote activation. All participating Pi sessions briefly reconnect with existing identities/state. Unknown restart ACK is checked by reconnect, not replayed." : "Export only returns current public bundle without changing validity, credentials, floors or gateway."} Transfer public updates and independently confirm full fingerprints on the peer. Root/account compromise requires re-pair BOTH machines. No process/PID killing, private key/floor deletion, hot reload, or automatic send replay.`,
    "Apply — perform reviewed pairing action",
  );
}
async function applyMaintenance(
  context: PairContext,
  { operation, input }: { operation: PairOperation; input: Record<string, unknown> },
): Promise<void> {
  const { setup, paths, pairing, config, agentDir, ctx, reconnect } = context;
  const activates = operation !== "export";
  const output = await pairAction(setup.executable, paths.directory, operation, input);
  let restart: "acknowledged" | "uncertain" | undefined;
  if (activates) {
    const imported =
      operation === "import"
        ? output
        : await pairAction(setup.executable, paths.directory, "import", {
            runtimeDir: pairing.runtimeDir,
            bundlePath: output.bundlePath,
            confirmedRootSha256: output.rootSha256,
            floorMode: "existing",
          });
    const gatewayBytes = await regularBytes(paths.gateway);
    if (gatewayBytes === undefined) {
      throw new Error("Gateway projection missing");
    }
    const old = currentPlan(config, gatewayBytes);
    const inspection = await pairAction(setup.executable, paths.directory, "inspect", {
      runtimeDir: pairing.runtimeDir,
    });
    await saveOwnedPlan(
      agentDir,
      setup,
      configured(old, pairing.intent, credentials(imported)),
      JSON.stringify({ ...pairing, inspection }),
    );
    restart = await requestManagedRestart(setup);
    try {
      await reconnect?.(true);
    } catch {
      restart = "uncertain";
    }
  }
  ctx.ui.notify(
    `Pair ${operation}: public action/staging completed${restart === "uncertain" ? "; activation/revocation NOT confirmed — reconnect and inspect; no control replay" : ""}: ${JSON.stringify(output)}. Public material only; transfer through the reviewed file exchange. Local may remain up, remote link readiness is unverified. Restart: ${restart ?? "not requested (public exchange only)"}. Current Pi runtime/nonce/volatile state was preserved, not silently reloaded. Local reconnection is not proof of an active remote link.`,
    "info",
  );
}

export function currentPlan(
  config: NonNullable<Awaited<ReturnType<typeof loadConfiguration>>>,
  gatewayBytes: Buffer,
): LocalPlan {
  const scopeId = config.scopeIds[0];
  if (scopeId === undefined) {
    throw new Error("No configured scope");
  }
  const permissions =
    config.policies.find(
      (grant) => grant.machineId === config.machineId && grant.scopeId === scopeId,
    )?.permissions ?? [];
  return {
    choices: {
      machineId: config.machineId,
      scopeId,
      label: config.label,
      permissions,
    },
    adapter: config,
    gateway: decodeGateway(parseJson(gatewayBytes)),
  };
}
export async function pairingInstructions(agentDir: string): Promise<string> {
  const bytes = await regularBytes(join(setupPaths(agentDir).directory, "pairing.json"));
  if (bytes === undefined) {
    return "No setup-managed pairing instructions.";
  }
  const pairing = decodePairing(parseJson(bytes));
  const available = { ...pairing.output, ...pairing.inspection };
  const publicFields = Object.fromEntries(
    ["offerPath", "requestPath", "requestSha256", "bundlePath", "rootSha256", "pairId"].flatMap(
      (key) => (typeof available[key] === "string" ? [[key, available[key]]] : []),
    ),
  );
  return `Public exchange: ${JSON.stringify(publicFields)}. ${pairing.intent.kind === "create" ? "Send public offer+full root SHA256 to peer through an independently trusted channel. Confirm their request SHA256 independently before Issue. After issuance IMPORT the refreshed bundle on BOTH machines (existing floor on creator; new only pending joiner)." : "Send public request+full request SHA256 to issuer via an independently trusted channel; then import its public bundle with confirmed full root SHA256."} ${pairing.intent.kind === "existing" ? "Existing-material issuer custody is not adopted; external renewal requires a signer/bundle matching this runtime's exact offer binding. Arbitrary external-CA renewal is not automated or proven." : ""} Runtime ${pairing.runtimeDir}. No key bytes are exchanged. Renew leaves/CRL and import before expiry; root/account compromise requires re-pair BOTH machines. Local up is not remote-linked proof.`;
}
