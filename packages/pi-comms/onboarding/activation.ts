import type { DialogContext } from "./dialog.js";
import { reviewAction } from "./dialog.js";
import { requestManagedRestart } from "./managed.js";
import type { ManagedSetup } from "./managed.js";

/** Explicit reviewed control only. Passive ensure/reconnect never calls this action. */
export async function activateSavedConfiguration(
  setup: ManagedSetup,
  ctx: DialogContext,
  reconnect?: (fresh?: boolean) => Promise<void>,
): Promise<void> {
  const approved = await reviewAction(
    ctx,
    "Activate saved configuration: send ONE machine-bound shared gateway restart request, then guarded reconnect of this SAME Pi runtime. No nonce, inbox, publications or interests are replaced. Other participants briefly disconnect; incompatible narrowed identities/scopes/grants remain refused.",
    `Saved configuration ${setup.gatewayPath}, expected SHA256 ${setup.gatewaySha256}. This is a fingerprint of loaded config bytes, NOT PKI-content freshness or remote link readiness. Restart outcome can be uncertain and is never automatically replayed. Surviving old sessions may still use old trust until the old gateway exits. An older gateway may reject guarded registration; never fall back to unguarded admission. No credential/floor/configuration changes or application request replay.`,
    "Apply — restart once and activate saved configuration",
  );
  if (!approved) {
    ctx.ui.notify("Activation cancelled — no changes made", "info");
    return;
  }
  const restart = await requestManagedRestart(setup);
  let connected = false;
  try {
    if (reconnect !== undefined) {
      await reconnect(true);
      connected = true;
    }
  } catch {
    // Guarded reconnect is bounded; an uncertain control outcome is never replayed.
  }
  ctx.ui.notify(
    restart === "acknowledged" && connected
      ? "Saved configuration activated with guarded local registration. Same Pi nonce/state retained; remote link readiness remains unverified. One restart request sent, no application requests replayed."
      : "Configuration saved; activation pending or unconfirmed. The running gateway may serve another generation or reject guarded registration. Existing sessions may still use old trust until it exits. Passive /comms reconnect only retries guarded admission; /comms setup → Activate saved configuration offers a separate explicitly reviewed restart. No automatic control replay.",
    restart === "acknowledged" && connected ? "info" : "warning",
  );
}
