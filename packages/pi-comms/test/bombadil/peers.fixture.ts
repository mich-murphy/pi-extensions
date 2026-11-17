// Launch fixture for peers.bombadil.ts. Starts a real local pi-gateway (a private copy of the debug
// build) and the scripted peer, and points the driven Pi at the same socket. dispose stops both.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, copyFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BombadilLaunch, BombadilRoot } from "../../../../test-support/bombadil.ts";
import { gatewayBinary } from "./gateway-binary.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const POLICIES = [
  { machineId: "alpha", scopeId: "team", permissions: ["discover", "read", "push", "interest"] },
];

async function ready(child: ChildProcess): Promise<void> {
  const stdout = child.stdout;
  if (stdout === null) {
    throw new Error("Gateway has no stdout");
  }
  // Split on \n only; the first line is the gateway's ready event.
  const line = new Promise<void>((resolve, reject) => {
    let text = "";
    const onData = (bytes: Buffer): void => {
      text += bytes.toString("utf8");
      if (text.includes("\n")) {
        stdout.off("data", onData);
        if (text.includes('"ready"')) {
          resolve();
        } else {
          reject(new Error("Gateway did not report ready"));
        }
      }
    };
    stdout.on("data", onData);
    child.once("exit", () => {
      reject(new Error("Gateway exited before ready"));
    });
  });
  await line;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

export default async function peersFixture(root: BombadilRoot): Promise<BombadilLaunch> {
  const source = gatewayBinary();
  // The gateway rejects symlinked ancestors, and /tmp is a symlink on macOS.
  const directory = join(realpathSync(root.root), "gw");
  mkdirSync(directory, { mode: 0o700 });
  const socketPath = join(directory, "g.sock");
  const gatewayConfig = join(directory, "gateway.json");
  writeFileSync(
    gatewayConfig,
    JSON.stringify({ machineId: "alpha", socketPath, scopeIds: ["team"], policies: POLICIES }),
  );
  const adapter = { machineId: "alpha", socketPath, scopeIds: ["team"], policies: POLICIES };
  writeFileSync(
    join(root.agent, "session-communication.json"),
    JSON.stringify({ ...adapter, label: "Driven Pi" }),
  );
  const peerConfig = join(directory, "peer.json");
  writeFileSync(peerConfig, JSON.stringify({ ...adapter, label: "Scripted peer" }));
  const binary = join(directory, "pi-gateway");
  copyFileSync(source, binary);
  chmodSync(binary, 0o500);
  const gateway = spawn(binary, ["--config", gatewayConfig], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let peer: ChildProcess | undefined;
  try {
    await ready(gateway);
    peer = spawn(
      process.execPath,
      ["--import", "jiti/register", join(here, "peers-peer.ts"), peerConfig],
      { cwd: repo, stdio: "ignore" },
    );
  } catch (error) {
    // The launcher runs no dispose when the fixture throws, so stop what already started.
    await stop(gateway);
    throw error;
  }
  const started = peer;
  return {
    args: ["--provider", "scripted", "--model", "peers"],
    omitDefaults: ["--no-tools"],
    dispose: async () => {
      await stop(started);
      await stop(gateway);
    },
  };
}
