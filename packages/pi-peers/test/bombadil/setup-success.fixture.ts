import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BombadilLaunch, BombadilRoot } from "../../../../test-support/bombadil.ts";
import { gatewayBinary } from "./gateway-binary.ts";

const running = (pattern: string): boolean => spawnSync("pgrep", ["-f", pattern]).status === 0;

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

async function stopAll(pattern: string): Promise<void> {
  spawnSync("pkill", ["-TERM", "-f", pattern]);
  if (!(await gone(pattern, 50))) {
    spawnSync("pkill", ["-KILL", "-f", pattern]);
  }
}

export default function successFixture(root: BombadilRoot): BombadilLaunch {
  const agentWithoutSymlinkedAncestors = realpathSync(root.agent);
  const homeWithoutSymlinkedAncestors = realpathSync(root.home);
  return {
    env: {
      HOME: homeWithoutSymlinkedAncestors,
      PI_CODING_AGENT_DIR: agentWithoutSymlinkedAncestors,
      PEERS_TEST_GATEWAY: gatewayBinary(),
    },
    dispose: async () => {
      await stopAll(join(agentWithoutSymlinkedAncestors, "pi-peers"));
    },
  };
}
