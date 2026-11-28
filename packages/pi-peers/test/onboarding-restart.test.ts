import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { requestManagedRestart } from "../onboarding/managed.js";
import type { ManagedSetup } from "../onboarding/managed.js";

function setupAt(socketPath: string): ManagedSetup {
  return {
    version: 1,
    executable: "/nonexistent/pi-gateway",
    executableSha256: "0".repeat(64),
    adapterSha256: "0".repeat(64),
    gatewaySha256: "0".repeat(64),
    gatewayPath: "/nonexistent/gateway.json",
    socketPath,
  };
}

async function deadSocket(path: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "require('node:net').createServer().listen(process.argv[1], () => process.stdout.write('ready'))",
      path,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await once(child.stdout, "data");
  child.kill("SIGKILL");
  await once(child, "exit");
}

describe("a managed restart request when no gateway runs", () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "pr-")));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  test("a missing socket means no gateway is running, so nothing is restarted", async () => {
    await expect(requestManagedRestart(setupAt(join(root, "s")))).resolves.toBe("not-running");
  });
  test("a socket left by a killed gateway, as after a reboot, means no gateway is running", async () => {
    const path = join(root, "s");
    await deadSocket(path);
    expect(existsSync(path)).toBe(true);
    await expect(requestManagedRestart(setupAt(path))).resolves.toBe("not-running");
  });
  test("a live socket is never treated as stopped; an unconfirmed restart stays uncertain", async () => {
    const path = join(root, "s");
    const server = createServer();
    server.listen(path);
    await once(server, "listening");
    await expect(requestManagedRestart(setupAt(path))).resolves.toBe("uncertain");
    server.close();
    await once(server, "close");
  });
});
