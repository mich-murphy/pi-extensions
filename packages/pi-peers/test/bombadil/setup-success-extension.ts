import { chmod, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { probedPeers } from "./setup-probe.ts";

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
        const copyKeepsRecordedSha256WhenCargoRebuilds = join(directory, "pi-gateway");
        await copyFile(source, copyKeepsRecordedSha256WhenCargoRebuilds);
        await chmod(copyKeepsRecordedSha256WhenCargoRebuilds, 0o500);
        progress("Copied the local debug gateway");

        return copyKeepsRecordedSha256WhenCargoRebuilds;
      },
    },
    "Bombadil test backend: copies the local debug gateway build.",
  );
}
