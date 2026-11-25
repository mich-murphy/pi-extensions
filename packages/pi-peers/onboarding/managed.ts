import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createConnection } from "node:net";
import { isAbsolute, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { EnsureGateway } from "../adapter/client.js";
import { GATEWAY_LOCAL_SETUP_CAPABILITIES, GATEWAY_WIRE_VERSION } from "./catalog.js";
import { digest, regularBytes, privateDirectory } from "./files.js";
import { Refusal } from "./refusal.js";
import { decodeRecord, parseJson } from "./schema.js";

const execute = promisify(execFile);
export type ManagedSetup = {
  version: 1;
  executable: string;
  executableSha256: string;
  adapterSha256: string;
  gatewaySha256: string;
  pairingSha256?: string;
  gatewayPath: string;
  socketPath: string;
};
export type ManagedSnapshot = {
  readonly state: "disabled" | "configured" | "degraded";
  readonly reason?: string;
  readonly text: string;
};
export async function managedSnapshot(setup: ManagedSetup): Promise<ManagedSnapshot> {
  const { stdout } = await execute(setup.executable, ["--diagnose", setup.gatewayPath], {
    timeout: 5000,
    maxBuffer: 16_384,
    env: gatewayEnvironment(),
  });
  const value = decodeRecord(parseJson(stdout));
  const remote = decodeRecord(value.remote);
  const state = remote.state;
  const reason = remote.reason;
  if (
    value.version !== 1 ||
    typeof state !== "string" ||
    !["disabled", "configured", "degraded"].includes(state) ||
    (reason !== undefined && (typeof reason !== "string" || !/^[a-z-]{1,64}$/u.test(reason)))
  ) {
    throw new Error("Native diagnostic contract mismatch");
  }
  const known = state === "disabled" || state === "configured" ? state : "degraded";
  return {
    state: known,
    ...(typeof reason === "string" ? { reason } : {}),
    text: `Remote config snapshot: ${state}${reason === undefined ? "" : ` (${reason})`}. Checked from saved credentials, not the live link.`,
  };
}
export async function diagnoseManaged(setup: ManagedSetup): Promise<string> {
  const snapshot = await managedSnapshot(setup);
  return snapshot.text;
}
export function gatewayEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
  };
}
export async function validateExecutable(
  executable: string,
  requiredCapabilities: readonly string[] = GATEWAY_LOCAL_SETUP_CAPABILITIES,
): Promise<void> {
  if (!isAbsolute(executable)) {
    throw new Error("Gateway executable must be absolute");
  }
  const { stdout } = await execute(executable, ["--version", "--json"], {
    timeout: 5000,
    maxBuffer: 16_384,
    env: gatewayEnvironment(),
  });
  const version = decodeRecord(parseJson(stdout));
  const capabilities = version.capabilities;
  if (
    version.name === "pi-gateway" &&
    !(Array.isArray(version.wireVersions) && version.wireVersions.includes(GATEWAY_WIRE_VERSION))
  ) {
    throw new Refusal(
      `the gateway program is out of date: it does not speak peers protocol v${String(GATEWAY_WIRE_VERSION)}`,
      "Run pi update to update the gateway, then choose Setup in /peers",
    );
  }
  if (
    version.name !== "pi-gateway" ||
    !Array.isArray(capabilities) ||
    !["managed-on-demand-v1", ...requiredCapabilities].every((capability) =>
      capabilities.includes(capability),
    )
  ) {
    throw new Refusal(
      "the gateway program is out of date",
      "Run pi update, then choose Setup in /peers",
    );
  }
}
async function reachable(path: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const finish = (value: boolean) => {
      socket.destroy();
      signal.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => {
      finish(false);
    };
    socket.setTimeout(150, () => {
      finish(false);
    });
    socket.once("error", () => {
      finish(false);
    });
    socket.once("connect", () => {
      finish(true);
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
  });
}
export function managedLauncher(
  setup: ManagedSetup,
  reload?: () => Promise<ManagedSetup>,
): EnsureGateway {
  return async (deadline, signal) => {
    const current = reload === undefined ? setup : await reload();
    startupDemand(deadline, signal);
    const connected = await reachable(current.socketPath, signal);
    startupDemand(deadline, signal);
    if (connected) {
      return { gatewaySha256: current.gatewaySha256 };
    }
    await validateExecutable(current.executable);
    startupDemand(deadline, signal);
    const config = await regularBytes(current.gatewayPath);
    if (config === undefined || digest(config) !== current.gatewaySha256) {
      throw new Error("gateway.json changed since setup, so the gateway was not started");
    }
    startupDemand(deadline, signal);
    await privateDirectory(dirname(current.gatewayPath));
    startupDemand(deadline, signal);
    const log = await open(
      join(dirname(current.gatewayPath), `startup-${randomBytes(12).toString("hex")}.log`),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const logStat = await log.stat();
      if (!logStat.isFile() || logStat.uid !== process.getuid?.() || (logStat.mode & 0o077) !== 0) {
        throw new Error("The gateway startup log is not private");
      }
      startupDemand(deadline, signal);
      const child = spawn(current.executable, ["--managed", "--config", current.gatewayPath], {
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
        env: gatewayEnvironment(),
        cwd: "/",
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    } finally {
      await log.close();
    }
    return { gatewaySha256: current.gatewaySha256 };
  };
}

function startupDemand(deadline: number, signal: AbortSignal): void {
  if (signal.aborted || performance.now() >= deadline) {
    throw new Error("Gateway startup cancelled");
  }
}

export async function requestManagedRestart(
  setup: ManagedSetup,
): Promise<"acknowledged" | "uncertain"> {
  try {
    const { stdout } = await execute(setup.executable, ["--request-restart", setup.gatewayPath], {
      timeout: 5000,
      maxBuffer: 16_384,
      env: gatewayEnvironment(),
    });
    const reply = decodeRecord(parseJson(stdout));
    return reply.version === 1 && reply.state === "restart-requested"
      ? "acknowledged"
      : "uncertain";
  } catch {
    return "uncertain";
  }
}
