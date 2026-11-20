// Test-only Pi extension for packages/pi-peers/test/bombadil/setup.bombadil.ts. Not shipped.
//
// Loads pi-peers with a backend that waits DELAY_MS, so the progress view is on screen long enough
// to be checked, and then refuses the acquisition: Apply never builds, downloads or starts a
// gateway. setup-probe.ts reports unreviewed disk changes in the footer.
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { probedPeers } from "./setup-probe.ts";

const DELAY_MS = 1500;

/** Loads pi-peers with the refusing backend. */
export default function bombadilSetupHarness(pi: ExtensionAPI): void {
  probedPeers(
    pi,
    {
      acquire: async () => {
        await delay(DELAY_MS);
        throw new Error("Bombadil test backend refuses acquisition");
      },
    },
    "Bombadil test backend: acquisition always refused; nothing is installed.",
  );
}
