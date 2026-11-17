import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadConfiguration } from "../adapter/config.js";
import { activateSavedConfiguration } from "./activation.js";
import { readManaged, setupPaths } from "./backend.js";
import { currentPlan, pairingInstructions } from "./continue.js";
import { reviewAction, selectChoice } from "./dialog.js";
import type { DialogContext } from "./dialog.js";
import { regularBytes } from "./files.js";
import { requestManagedRestart } from "./managed.js";
import type { ManagedSetup } from "./managed.js";
import type { LocalPlan } from "./plan.js";
import { prepareRemote, remoteIntent, remoteReview } from "./remote.js";
import { saveOwnedPlan } from "./update.js";

export type ActivatePlan = (
  plan: LocalPlan,
  setup: ManagedSetup,
  replace?: boolean,
) => Promise<void>;
/** An owned local-only installation may add a peer; custom/external configs are never adopted. */
export async function upgradeLocal(
  agentDir: string,
  ctx: DialogContext,
  activate: ActivatePlan,
  reconnect?: (fresh?: boolean) => Promise<void>,
): Promise<boolean> {
  const config = await loadConfiguration(agentDir);
  if (config === undefined) {
    return false;
  }
  const setup = await readManaged(agentDir, config);
  if (setup === undefined) {
    return false;
  }
  const choice = await selectChoice(
    ctx,
    "Setup-owned local participation already configured. Keep current runtime or explicitly review adding one remote peer.",
    [
      "Cancel — no changes",
      "Keep and reconnect",
      "Activate saved configuration",
      "Add one remote peer",
    ],
  );
  if (choice === "Activate saved configuration") {
    await activateSavedConfiguration(setup, ctx, reconnect);
    return true;
  }
  if (choice === "Keep and reconnect") {
    await reconnect?.();
    return true;
  }
  if (choice !== "Add one remote peer") {
    return true;
  }
  const intent = await remoteIntent(ctx);
  if (intent === undefined) {
    return true;
  }
  if (intent.localMachineId !== undefined && intent.localMachineId !== config.machineId) {
    throw new Error(
      "Offer targets another machine identity; existing identity is preserved. Use the correct offer/profile.",
    );
  }
  const paths = setupPaths(agentDir);
  const directory = join(paths.directory, `pair-${randomBytes(12).toString("hex")}`);
  const consent = await reviewAction(
    ctx,
    `Add remote ${intent.peerMachineId}: ${intent.endpoint.mode} ${intent.endpoint.address}.\nALL projects on this account; published records only.\nUntrusted peer messages may wake model + provider cost.\nApply replaces THIS Pi runtime: loses inbox/publications/interests/receipts.\nOther Pis keep old conservative grants until restarted.\nShared gateway briefly restarts; no send replay.`,
    `${remoteReview(intent, directory)}\nPreserve machine identity/scopes/local grants. Reuse hash-verified setup executable. Write fresh pair generation; CAS only unchanged owned config/metadata. Explicitly replace this Pi runtime only while idle, with new nonce and volatile inbox/publications/interests/receipts lost. Other already-open Pi runtimes retain their earlier conservative adapter policies; compatible identity/scopes can reconnect to updated gateway. No blanket /reload, process/PID killing, credential/floor deletion or uncertain-send replay. Gateway: ${paths.gateway}; adapter: ${paths.adapter}; metadata: ${paths.metadata}.`,
    "Apply — add peer, restart gateway and replace this Pi runtime",
  );
  if (!consent) {
    return true;
  }
  const bytes = await regularBytes(paths.gateway);
  if (bytes === undefined) {
    throw new Error("Owned gateway projection missing");
  }
  const next = await prepareRemote(setup.executable, directory, currentPlan(config, bytes), intent);
  const pairing = await regularBytes(join(directory, "pairing.json"));
  if (pairing === undefined) {
    throw new Error("Pairing manifest missing");
  }
  await saveOwnedPlan(agentDir, setup, next, pairing.toString("utf8"), true);
  const restart = await requestManagedRestart(setup);
  const updated = await readManaged(agentDir, next.adapter);
  if (updated === undefined) {
    throw new Error("Updated setup ownership missing");
  }
  await activate(next, updated, true);
  ctx.ui.notify(
    `Remote addition saved; shared restart ${restart}; this Pi runtime explicitly replaced. ${await pairingInstructions(agentDir)} Local connection is separate from remote link readiness.`,
    "info",
  );
  return true;
}
