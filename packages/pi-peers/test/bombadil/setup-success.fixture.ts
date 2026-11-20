// Launch fixture for setup-success.bombadil.ts. Points setup-success-extension.ts at the debug
// gateway, and gives Pi canonical HOME and agent paths: the gateway rejects symlinked ancestors and
// /tmp is a symlink on macOS. The default socket under the canonical home stays near 68 bytes, under
// the 100-byte limit. The gateway setup starts is detached and outlives Pi, so dispose stops every
// process running from the throwaway agent directory before the launcher deletes it.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BombadilLaunch, BombadilRoot } from "../../../../test-support/bombadil.ts";
import { gatewayBinary } from "./gateway-binary.ts";

const running = (pattern: string): boolean => spawnSync("pgrep", ["-f", pattern]).status === 0;

/** Waits up to `tries` × 100 ms for no process to match `pattern`. */
async function gone(pattern: string, tries: number): Promise<boolean> {
  if (!running(pattern)) {
    return true;
  }
  if (tries === 0) {
    return false;
  }
  await delay(100);
  return gone(pattern, tries - 1);
}

/** Stops every process whose command line contains `pattern`: SIGTERM, then SIGKILL after 5 s. */
async function stopAll(pattern: string): Promise<void> {
  spawnSync("pkill", ["-TERM", "-f", pattern]);
  if (!(await gone(pattern, 50))) {
    spawnSync("pkill", ["-KILL", "-f", pattern]);
  }
}

export default function successFixture(root: BombadilRoot): BombadilLaunch {
  const agent = realpathSync(root.agent);
  return {
    env: {
      HOME: realpathSync(root.home),
      PI_CODING_AGENT_DIR: agent,
      PEERS_TEST_GATEWAY: gatewayBinary(),
    },
    dispose: async () => {
      await stopAll(join(agent, "pi-peers"));
    },
  };
}
