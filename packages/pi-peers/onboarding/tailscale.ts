import { execFile } from "node:child_process";
import { lstat, open, readlink, realpath, stat } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
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
const isNotRunning = Schema.is(Schema.Struct({ code: Schema.Literal("tailscale-not-running") }));
const decodeState = Schema.decodeUnknownSync(Schema.Struct({ BackendState: Schema.String }));

const decodeSelf = Schema.decodeUnknownSync(
  Schema.Struct({
    Self: Schema.Struct({ DNSName: Schema.String, TailscaleIPs: Schema.Array(Schema.String) }),
  }),
);

const NOT_RUNNING = /doesn't appear to be running|not running|NeedsLogin|logged out/iu;

const MAX_LINKS = 8;
const MAX_SCRIPT = 4096;
const SEPARATORS = /[\s"'`;=:(){}<>|&$]/u;
const SHEBANG = [0x23, 0x21];

class UntrustedCommand extends Error {
  constructor() {
    super("untrusted tailscale command");
  }
}

function ownerOk(owner: number, uid: number | undefined): boolean {
  return owner === 0 || owner === uid;
}

async function followLinks(path: string, uid: number | undefined, links: number): Promise<string> {
  const entry = await lstat(path);

  if (!entry.isSymbolicLink()) {
    return path;
  }

  if (links >= MAX_LINKS || !ownerOk(entry.uid, uid)) {
    throw new UntrustedCommand();
  }

  const target = await readlink(path);

  return followLinks(isAbsolute(target) ? target : `${dirname(path)}/${target}`, uid, links + 1);
}

async function header(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r");

  try {
    const buffer = new Uint8Array(MAX_SCRIPT + SHEBANG.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);

    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (entry) => entry.isFile(),
    () => false,
  );
}

async function script(text: string, uid: number | undefined, depth: number): Promise<void> {
  const [first = "", ...lines] = text.split("\n");
  const interpreter = first.trim().split(/\s+/u)[0] ?? "";

  if (interpreter === "") {
    throw new UntrustedCommand();
  }

  await trusted(interpreter, uid, depth + 1);

  const tokens = lines
    .filter((line) => !line.trimStart().startsWith("#"))
    .flatMap((line) => line.split(SEPARATORS))
    .filter((token) => token.startsWith("/"));

  const files = await Promise.all(tokens.map(async (token) => isFile(token)));

  await Promise.all(
    tokens
      .filter((_token, index) => files[index] === true)
      .map(async (token) => trusted(token, uid, depth + 1)),
  );
}

async function trusted(path: string, uid: number | undefined, depth: number): Promise<string> {
  if (!isAbsolute(path)) {
    throw new UntrustedCommand();
  }

  const program = await realpath(await followLinks(path, uid, 0));
  const entry = await stat(program);

  if (
    !entry.isFile() ||
    !ownerOk(entry.uid, uid) ||
    (entry.mode & 0o022) !== 0 ||
    (entry.mode & 0o111) === 0
  ) {
    throw new UntrustedCommand();
  }

  const bytes = await header(program);

  if (bytes[0] !== SHEBANG[0] || bytes[1] !== SHEBANG[1]) {
    return program;
  }

  const rest = bytes.subarray(SHEBANG.length);

  if (depth > 0 || rest.length >= MAX_SCRIPT - SHEBANG.length) {
    throw new UntrustedCommand();
  }

  await script(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rest), uid, depth);

  return program;
}

async function present(path: string): Promise<boolean> {
  return (
    !isAbsolute(path) ||
    lstat(path).then(
      () => true,
      () => false,
    )
  );
}

export async function findTailscale(
  candidates: ReadonlyArray<string> = TAILSCALE_PATHS,
): Promise<string> {
  const found = await Promise.all(candidates.map(async (candidate) => present(candidate)));
  const candidate = candidates[found.indexOf(true)];

  if (candidate === undefined) {
    throw new TailscaleRefusal("tailscale-missing");
  }

  try {
    return await trusted(candidate, process.geteuid?.(), 0);
  } catch {
    throw new TailscaleRefusal("tailscale-error");
  }
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

const decodeWhois = Schema.decodeUnknownSync(
  Schema.Struct({
    Node: Schema.Struct({ Name: Schema.String, Addresses: Schema.Array(Schema.String) }),
  }),
);

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,62})$/u;

function sameAddress(prefix: string, address: string): boolean {
  const [host = ""] = prefix.split("/");
  const family = isIP(address) === 6 ? "ipv6" : "ipv4";
  const list = new BlockList();
  list.addAddress(address, family);

  return isIP(host) === isIP(address) && list.check(host, family);
}

export async function whoisName(command: string, address: string): Promise<string> {
  let output: string;

  try {
    output = await run(command, ["whois", "--json", address]);
  } catch (error) {
    throw isNotRunning(error)
      ? new TailscaleRefusal("tailscale-not-running")
      : new RefusalError(
          `no tailnet computer has the address ${address}`,
          "Check the address with tailscale status, or enter the other computer's MagicDNS name",
        );
  }

  try {
    const node = decodeWhois(parseJson(output)).Node;
    const name = (node.Name.split(".")[0] ?? "").toLowerCase();

    if (!LABEL.test(name) || !node.Addresses.some((prefix) => sameAddress(prefix, address))) {
      throw new Error("Tailscale whois does not name this address");
    }

    return name;
  } catch {
    throw new TailscaleRefusal("tailscale-error");
  }
}

export function listenAddress(self: TailscaleSelf): string {
  const address =
    self.addresses.find((candidate) => isIP(candidate) === 4) ?? self.addresses[0] ?? "";

  if (address === "") {
    throw new TailscaleRefusal("tailscale-not-running");
  }

  return address;
}
