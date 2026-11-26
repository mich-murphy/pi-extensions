import { requestManagedRestart } from "./managed.js";
import type { ManagedSetup } from "./managed.js";
import { actionForm, withTechnical } from "./menu/forms.js";
import type { Progress } from "./menu/forms.js";
import type { Screen } from "./menu/model.js";
import type { Outcome, Step } from "./menu/progress.js";
import { failed } from "./outcome.js";
import type { Reconnect } from "./route.js";

const STEPS = ["Restarting the gateway once", "Reconnecting this Pi"] as const;

async function reconnectedOnceWithoutReplay(reconnect: Reconnect | undefined): Promise<boolean> {
  if (reconnect === undefined) {
    return false;
  }

  try {
    await reconnect(true);

    return true;
  } catch {
    return false;
  }
}

async function activateSaved(
  setup: ManagedSetup,
  step: Step,
  reconnect: Reconnect | undefined,
): Promise<Outcome> {
  step(STEPS[0]);
  const restart = await requestManagedRestart(setup);
  step(STEPS[1]);
  const connected = await reconnectedOnceWithoutReplay(reconnect);

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

  return failed(
    "Activation failed",
    restart === "acknowledged"
      ? "this Pi could not reconnect"
      : "the gateway did not confirm the restart",
    "Your settings are saved. Choose Reconnect in a minute, or close other Pi sessions first.",
    [`Restart ${restart}.`],
  );
}

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
          "This Pi keeps its identity and inbox.",
          "Nothing is written, and keys and settings are not changed.",
        ],
        [
          `Saved configuration ${setup.gatewayPath}, expected SHA256 ${setup.gatewaySha256}. This checks the saved file, not whether remote links work. An unconfirmed restart is never retried. Other sessions may keep the old trust until the old gateway exits. An older gateway may refuse this Pi; it never connects without the check. Keys and settings are unchanged; nothing is resent.`,
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
