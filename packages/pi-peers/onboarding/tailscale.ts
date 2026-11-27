import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { Schema } from "effect";
import { errnoCode } from "../../shared/errno.js";
import { gatewayEnvironment } from "./managed.js";
import { RefusalError } from "./refusal.js";
import { parseJson } from "./schema.js";

const execute = promisify(execFile);

export const TAILSCALE_PATHS: ReadonlyArray<string> = [
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/bin/tailscale",
  "/run/current-system/sw/bin/tailscale",
  "/nix/var/nix/profiles/default/bin/tailscale",
];

type Degraded =
  | "tailscale-missing"
  | "tailscale-not-running"
  | "tailscale-error"
  | "not-tailnet-address";

const DEGRADED: Record<Degraded, { readonly problem: string; readonly next: string }> = {
  "tailscale-missing": {
    problem: "Tailscale is not installed on this computer",
    next: "Install Tailscale, or set remote.tailscale in gateway.json to its absolute path",
  },
  "tailscale-not-running": {
    problem: "Tailscale is not running or not logged in",
    next: "Start Tailscale and log in",
  },
  "tailscale-error": {
    problem: "Tailscale failed or gave an unexpected answer",
    next: "Run tailscale status and fix what it reports",
  },
  "not-tailnet-address": {
    problem: "the link address is not a usable tailnet computer",
    next: "Link again: listen on this computer's tailnet IP, or connect to another tailnet computer",
  },
};

const isDegraded = Schema.is(
  Schema.Literals([
    "tailscale-missing",
    "tailscale-not-running",
    "tailscale-error",
    "not-tailnet-address",
  ]),
);

export function degradedText(reason: string): string | undefined {
  return isDegraded(reason)
    ? `${DEGRADED[reason].problem.replace(/^./u, (first) => first.toUpperCase())}. ${DEGRADED[reason].next}`
    : undefined;
}

class TailscaleRefusal extends RefusalError {
  constructor(readonly code: Degraded) {
    super(DEGRADED[code].problem, DEGRADED[code].next);
  }
}

export type TailscaleSelf = {
  readonly name: string;
  readonly addresses: ReadonlyArray<string>;
};

const isFailure = Schema.is(Schema.Struct({ stderr: Schema.String }));
const decodeState = Schema.decodeUnknownSync(Schema.Struct({ BackendState: Schema.String }));

const decodeSelf = Schema.decodeUnknownSync(
  Schema.Struct({
    Self: Schema.Struct({ DNSName: Schema.String, TailscaleIPs: Schema.Array(Schema.String) }),
  }),
);

const NOT_RUNNING = /doesn't appear to be running|not running|NeedsLogin|logged out/iu;

type Probe = "missing" | "unsafe" | "found";

async function probe(path: string): Promise<Probe> {
  try {
    const entry = await stat(path);
    const owner = entry.uid === 0 || entry.uid === process.getuid?.();

    return entry.isFile() && owner && (entry.mode & 0o022) === 0 && (entry.mode & 0o111) !== 0
      ? "found"
      : "unsafe";
  } catch (error) {
    return errnoCode(error) === "ENOENT" || errnoCode(error) === "ENOTDIR" ? "missing" : "unsafe";
  }
}

export async function findTailscale(
  candidates: ReadonlyArray<string> = TAILSCALE_PATHS,
): Promise<string> {
  const probes = await Promise.all(candidates.map(async (candidate) => probe(candidate)));
  const index = probes.findIndex((result) => result !== "missing");
  const found = candidates[index];

  if (found === undefined) {
    throw new TailscaleRefusal("tailscale-missing");
  }

  if (probes[index] === "unsafe") {
    throw new TailscaleRefusal("tailscale-error");
  }

  return found;
}

async function run(command: string, args: ReadonlyArray<string>): Promise<string> {
  try {
    const { stdout } = await execute(command, [...args], {
      timeout: 5000,
      maxBuffer: 65_536,
      env: gatewayEnvironment(),
    });

    return stdout;
  } catch (error) {
    throw isFailure(error) && NOT_RUNNING.test(error.stderr)
      ? new TailscaleRefusal("tailscale-not-running")
      : new TailscaleRefusal("tailscale-error");
  }
}

export async function tailscaleSelf(command: string): Promise<TailscaleSelf> {
  const output = await run(command, ["status", "--json", "--peers=false"]);
  let value: ReturnType<typeof parseJson>;
  let state: string;

  try {
    value = parseJson(output);
    state = decodeState(value).BackendState;
  } catch {
    throw new TailscaleRefusal("tailscale-error");
  }

  if (state !== "Running") {
    throw new TailscaleRefusal("tailscale-not-running");
  }

  try {
    const self = decodeSelf(value).Self;
    const name = self.DNSName.split(".")[0] ?? "";
    const addresses = self.TailscaleIPs.filter((address) => isIP(address) !== 0);

    if (name === "" || addresses.length === 0) {
      throw new Error("Tailscale status has no name or address");
    }

    return { name: name.toLowerCase(), addresses };
  } catch {
    throw new TailscaleRefusal("tailscale-error");
  }
}

export async function resolveHost(command: string, host: string): Promise<string> {
  if (isIP(host) !== 0) {
    return host;
  }

  let output: string;

  try {
    output = await run(command, ["ip", "-1", host]);
  } catch {
    throw new RefusalError(
      `no tailnet computer is called ${host}`,
      "Check the name with tailscale status, or enter its tailnet IP",
    );
  }

  const address = output.trim().split("\n")[0]?.trim() ?? "";

  if (isIP(address) === 0) {
    throw new TailscaleRefusal("tailscale-error");
  }

  return address;
}

export function listenAddress(self: TailscaleSelf): string {
  const address =
    self.addresses.find((candidate) => isIP(candidate) === 4) ?? self.addresses[0] ?? "";

  if (address === "") {
    throw new TailscaleRefusal("tailscale-not-running");
  }

  return address;
}
