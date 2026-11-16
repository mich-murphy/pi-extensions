// Launch fixture for setup-apply.bombadil.ts: points setup-apply-extension.ts at the locally
// built debug gateway and writes the files the remote paths ask for under <root>/fx (a public
// offer for "Join a new trusted pair" and dummy trust material). The specification types these
// paths, reading <root> from the cwd row in Pi's footer. Dispose kills any pi-gateway process
// whose command line names the throwaway root.
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BombadilFixture } from "../../../../test-support/bombadil.ts";

const gateway = fileURLToPath(new URL("../../gateway/target/debug/pi-gateway", import.meta.url));
const DUMMIES = ["root.der", "leaf.der", "key.pem", "crl.der", "floor.json", "bundle.json"];

/** Terminates every pi-gateway process whose command line contains `root`. */
function killGateways(root: string): void {
  const listing = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  for (const line of listing.split("\n")) {
    const groups = /^\s*(?<pid>\d+)\s(?<command>.*)$/u.exec(line)?.groups;
    const command = groups?.command ?? "";
    if (command.includes(root) && command.includes("pi-gateway")) {
      try {
        process.kill(Number(groups?.pid), "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
}

const fixture: BombadilFixture = (root) => {
  const fx = join(realpathSync(root.root), "fx");
  mkdirSync(fx, { mode: 0o700 });
  writeFileSync(
    join(fx, "offer.json"),
    JSON.stringify({ machineId: "peer-a", peerMachineId: "laptop" }),
  );
  for (const name of [...DUMMIES, "request.json"]) {
    writeFileSync(join(fx, name), "not real trust material\n", { mode: 0o600 });
  }
  return {
    env: { BOMBADIL_COMMS_GATEWAY: gateway },
    // root.root is /tmp/...; on macOS gateways run from /private/tmp/..., which contains it.
    dispose: () => {
      killGateways(root.root);
    },
  };
};
export default fixture;
