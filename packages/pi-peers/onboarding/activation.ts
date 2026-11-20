import { requestManagedRestart } from "./managed.js";
import type { ManagedSetup } from "./managed.js";
import { actionForm, withTechnical } from "./menu/forms.js";
import type { Progress } from "./menu/forms.js";
import type { Screen } from "./menu/model.js";
import type { Outcome, Step } from "./menu/progress.js";
import type { Reconnect } from "./route.js";

const STEPS = ["Restarting the gateway once", "Reconnecting this Pi"] as const;

/** Explicit reviewed control only. Passive ensure/reconnect never calls this action. */
async function activateSaved(
  setup: ManagedSetup,
  step: Step,
  reconnect: Reconnect | undefined,
): Promise<Outcome> {
  step(STEPS[0]);
  const restart = await requestManagedRestart(setup);
  step(STEPS[1]);
  let connected = false;
  try {
    if (reconnect !== undefined) {
      await reconnect(true);
      connected = true;
    }
  } catch {
    // Guarded reconnect is bounded; an uncertain control outcome is never replayed.
  }
  if (restart === "acknowledged" && connected) {
    return {
      ok: true,
      headline: "✓ Saved configuration activated",
      facts: [],
      next: "This Pi kept its identity and state. Choose Doctor to check the remote link.",
      technical: [
        "Saved configuration activated with guarded local registration. Same Pi nonce/state retained; remote link readiness remains unverified. One restart request sent, no application requests replayed.",
      ],
    };
  }
  return {
    ok: false,
    headline: "✗ Activation not confirmed — settings saved, not active yet",
    facts: [],
    next: "Choose Reconnect later. If it still waits, another session may still use the old gateway until it closes.",
    technical: [
      `Restart ${restart}. Configuration saved; activation pending or unconfirmed. The running gateway may serve another generation or reject guarded registration. Existing sessions may still use old trust until it exits. Passive reconnect only retries guarded admission. No automatic control replay.`,
    ],
  };
}

/** `Activate saved configuration`: one restart of the shared gateway, then this Pi reconnects. */
export function activationScreen(
  setup: ManagedSetup,
  progress: Progress,
  reconnect: Reconnect | undefined,
): Screen {
  return actionForm({
    title: "Activate",
    note: "Restarts the shared gateway once so it uses the saved settings, then reconnects this Pi. Other sessions briefly disconnect.",
    details: () =>
      withTechnical(
        [
          "This Pi keeps its identity, inbox and publications.",
          "Nothing is written, and keys and settings are not changed.",
        ],
        [
          `Saved configuration ${setup.gatewayPath}, expected SHA256 ${setup.gatewaySha256}. This is a fingerprint of loaded config bytes, NOT PKI-content freshness or remote link readiness. Restart outcome can be uncertain and is never automatically replayed. Surviving old sessions may still use old trust until the old gateway exits. An older gateway may reject guarded registration; never fall back to unguarded admission. No credential/floor/configuration changes or application request replay.`,
        ],
      ),
    detailsDescription: "What activating restarts and keeps.",
    consent: () => ({
      label: "Restart and activate",
      action: "Activate",
      gate: { kind: "ready", value: undefined },
      description: "Restart the gateway once and reconnect this Pi.",
      run: () => {
        progress("Activating", STEPS, async (step) => activateSaved(setup, step, reconnect));
      },
    }),
  });
}
