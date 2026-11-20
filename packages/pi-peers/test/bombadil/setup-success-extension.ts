// Test-only Pi extension for packages/pi-peers/test/bombadil/setup-success.bombadil.ts. Not shipped.
//
// Loads pi-peers with a backend whose acquisition copies the locally built debug gateway (path in
// PEERS_TEST_GATEWAY, set by setup-success.fixture.ts) into the staging directory setup gives it,
// as production staging does: a private directory, a copy, then read and execute only. A copy, not
// the cargo output itself, because setup records the executable's SHA256 and a rebuild would change
// it. setup-probe.ts reports unreviewed disk changes in the footer.
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { probedPeers } from "./setup-probe.ts";

/** Loads pi-peers with the copying backend. */
export default function bombadilSuccessHarness(pi: ExtensionAPI): void {
  probedPeers(
    pi,
    {
      acquire: async (directory, progress) => {
        const source = process.env.PEERS_TEST_GATEWAY;
        if (source === undefined || source === "") {
          throw new Error("PEERS_TEST_GATEWAY is not set; run through setup-success.fixture.ts");
        }
        await mkdir(directory, { mode: 0o700 });
        const target = join(directory, "pi-gateway");
        await copyFile(source, target);
        await chmod(target, 0o500);
        progress("Copied the local debug gateway");
        return target;
      },
    },
    "Bombadil test backend: copies the local debug gateway build.",
  );
}
