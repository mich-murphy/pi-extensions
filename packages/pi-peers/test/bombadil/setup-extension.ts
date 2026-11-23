import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { probedPeers } from "./setup-probe.ts";

const DELAY_MS = 1500;

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
