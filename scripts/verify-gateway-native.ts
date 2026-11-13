/**
 * CI consumer proof of PUBLIC native acquisition on a native runner.
 *
 *   node --import jiti/register scripts/verify-gateway-native.ts --target T --runner-temp DIR --out RECORD
 *
 * Runs production `acquireGateway` (method native, default `gatewayCatalog.native`, no seams, no
 * catalog override, production 120 s deadline) against the published GitHub release. It fails,
 * creating nothing, while the default catalog has no native pin; it never skips.
 *
 * Before any product call, a fresh private root is created under canonical RUNNER_TEMP with its
 * own 0700 HOME, TMPDIR and install directory, and the record is created exclusively. After
 * acquisition this script checks independently that the recorded executable is canonical and
 * inside this root's install directory, digests the bytes it actually reads (bounded, owned
 * policy), checks the installed manifest against the pin, and runs a bounded `--version --json`
 * probe that settles only once the child has closed. No daemon or PKI is ever started.
 *
 * The root is removed only after every check passed and its device, inode, owner and mode are
 * confirmed again. On any failure, including a child whose shutdown is uncertain, the root is
 * retained for runner teardown. Once known, the root is named in the record and the thrown error
 * with its state (retained, cleanup unconfirmed or removed). No other path is ever removed.
 */
import { spawn } from "node:child_process";
import type { BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { acquireGateway } from "../packages/pi-comms/onboarding/acquire.js";
import {
  MAX_BINARY,
  gatewayReleaseTag,
  jsonObject,
  sha256,
  verifyManifest,
} from "../packages/pi-comms/onboarding/artifact.js";
import {
  GATEWAY_MANAGED_CAPABILITY,
  GATEWAY_REMOTE_SETUP_CAPABILITIES,
  GATEWAY_WIRE_VERSION,
  gatewayCatalog,
  gatewayTarget,
} from "../packages/pi-comms/onboarding/catalog.js";
import type { GatewayReleasePin } from "../packages/pi-comms/onboarding/catalog.js";
import { createRecord, currentUid, readRegular, requireAbsent } from "./verify-gateway-nix-io.js";
import type { RecordWriter } from "./verify-gateway-nix-io.js";

const ROOT_PREFIX = "gateway-public-native-";
const ROOT_NAME = /^gateway-public-native-[A-Za-z0-9]{6}$/u;
/** Same deadline production setup gives the native fallback. */
const ACQUISITION_MS = 120_000;
const PROBE_MS = 10_000;
/** After SIGKILL to our own child, how long to wait for it to close before declaring uncertainty. */
const CLOSE_GRACE_MS = 5000;
/** Version output and the installed manifest are small JSON documents (manifest bound as in production). */
const MAX_JSON = 65_536;
const REQUIRED_CAPABILITIES = [GATEWAY_MANAGED_CAPABILITY, ...GATEWAY_REMOTE_SETUP_CAPABILITIES];

type Root = { root: string; dev: bigint; ino: bigint; uid: number };

function isPrivateDirectory(stat: BigIntStats, uid: number): boolean {
  return stat.isDirectory() && stat.uid === BigInt(uid) && (stat.mode & 0o077n) === 0n;
}

/** At most 8 links of the cause chain; a non-Error ends it. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let item: unknown = error;
  while (item !== undefined && chain.length < 8) {
    chain.push(item);
    item = item instanceof Error ? item.cause : undefined;
  }
  return chain;
}

function messageOf(item: unknown): string {
  return item instanceof Error ? item.message : (JSON.stringify(item) ?? typeof item);
}

/** Bounded cause chain; token-shaped strings are redacted. */
function describe(error: unknown): string {
  return causeChain(error)
    .map((item) => messageOf(item))
    .join("\n  caused by: ")
    .replaceAll(/\b(?:gh[opsur]|github_pat)_[A-Za-z0-9_]+/gu, "[redacted]")
    .slice(0, 8000);
}

/** Target and default native pin first: an unpublished pin fails before anything is created. */
function requirePin(target: string): GatewayReleasePin {
  if (gatewayTarget() !== target) {
    throw new Error(`Host target ${gatewayTarget()} does not match matrix target ${target}`);
  }
  if (gatewayCatalog.native === null) {
    throw new Error(
      "Default catalog has no native pin: public native acquisition cannot be verified until the release is published and pinned",
    );
  }
  return gatewayCatalog.native;
}

async function createRoot(runnerTemp: string): Promise<Root> {
  if (!path.isAbsolute(runnerTemp)) {
    throw new Error("--runner-temp must be absolute");
  }
  const root = await fs.mkdtemp(path.join(await fs.realpath(runnerTemp), ROOT_PREFIX));
  try {
    const stat = await fs.lstat(root, { bigint: true });
    if (!isPrivateDirectory(stat, currentUid())) {
      throw new Error("not a private directory");
    }
    return { root, dev: stat.dev, ino: stat.ino, uid: currentUid() };
  } catch (error) {
    throw new Error(`Fresh root ${root} not confirmed private; retained`, { cause: error });
  }
}

/** Private HOME/TMPDIR/install inside the root, set before any product call or child process. */
async function privateProfile(root: string) {
  const dirs = {
    home: path.join(root, "home"),
    tmp: path.join(root, "tmp"),
    installRoot: path.join(root, "install"),
  };
  await Promise.all(Object.values(dirs).map(async (dir) => fs.mkdir(dir, { mode: 0o700 })));
  process.env.HOME = dirs.home;
  process.env.TMPDIR = dirs.tmp;
  return dirs;
}

/** Recorded executable is canonical, named pi-gateway, in a direct child of this install root. */
async function requireOwnedExecutable(
  executable: string,
  installRoot: string,
  ownedPaths: string[],
) {
  const canonical = (await fs.realpath(executable)) === executable;
  if (!canonical || !inInstallLayout(executable, installRoot, ownedPaths)) {
    throw new Error(
      `Acquired executable ${executable} is not canonical inside the owned install root`,
    );
  }
}

/** `<installRoot>/<version dir>/pi-gateway`, and every owned path is such a version directory. */
function inInstallLayout(executable: string, installRoot: string, ownedPaths: string[]): boolean {
  const inside = (file: string) => path.dirname(file) === installRoot;
  return (
    path.basename(executable) === "pi-gateway" &&
    inside(path.dirname(executable)) &&
    ownedPaths.length > 0 &&
    ownedPaths.every((file) => inside(file))
  );
}

/** Installed manifest still matches the pin, and its target record matches the bytes read. */
async function verifyInstalled(executable: string, pin: GatewayReleasePin, target: string) {
  const binary = await readRegular(executable, MAX_BINARY, "owned");
  const manifest = await readRegular(
    path.join(path.dirname(executable), "manifest.json"),
    MAX_JSON,
    "owned",
  );
  const { record } = verifyManifest(manifest.bytes, pin, target);
  const binarySha256 = sha256(binary.bytes);
  if (binarySha256 !== record.binarySha256 || binary.bytes.length !== record.binarySize) {
    throw new Error("Acquired binary differs from the pinned manifest record");
  }
  return {
    binarySha256,
    binarySize: binary.bytes.length,
    mode: (binary.stat.mode & 0o777n).toString(8),
  };
}

/**
 * `--version --json` of our own child. Settles only on its `close`; on timeout or oversized
 * output that child (and only it) is killed. If it still does not close, the result is an
 * uncertain-shutdown error and the caller retains the root.
 */
async function probeVersion(executable: string, home: string, tmp: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--version", "--json"], {
      env: { HOME: home, TMPDIR: tmp, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    let abandon: NodeJS.Timeout | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill("SIGKILL");
      abandon ??= setTimeout(() => {
        child.stdout.destroy();
        child.unref();
        reject(new Error("Version probe child did not close after SIGKILL; root retained"));
      }, CLOSE_GRACE_MS);
    };
    const deadline = setTimeout(() => {
      stop(new Error("Version probe timed out"));
    }, PROBE_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_JSON) {
        stop(new Error("Version output exceeds bound"));
      } else {
        chunks.push(chunk);
      }
    });
    child.on("error", (error) => {
      if (child.pid === undefined) {
        clearTimeout(deadline);
        reject(error);
      } else {
        failure ??= error;
      }
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      clearTimeout(abandon);
      if (failure !== undefined || code !== 0) {
        reject(failure ?? new Error(`Version probe exited with ${String(code)}`));
      } else {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
  });
}

/** The probed gateway is pi-gateway at exactly the pinned version. */
function isPinnedGateway(version: Record<string, unknown>, expected: string): boolean {
  return version.name === "pi-gateway" && version.version === expected;
}

/** It speaks our wire version and advertises every capability remote setup requires. */
function isAbiCompatible({ wireVersions, capabilities }: Record<string, unknown>): boolean {
  const speaksWire = Array.isArray(wireVersions) && wireVersions.includes(GATEWAY_WIRE_VERSION);
  return (
    speaksWire &&
    Array.isArray(capabilities) &&
    REQUIRED_CAPABILITIES.every((capability) => capabilities.includes(capability))
  );
}

function verifyVersion(version: Record<string, unknown>, expected: string) {
  const { name, wireVersions, capabilities } = version;
  if (!isPinnedGateway(version, expected) || !isAbiCompatible(version)) {
    throw new Error("Public native gateway ABI/capability mismatch");
  }
  return { name, version: version.version, wireVersions, capabilities };
}

/** Version probing must not have written to the private profile. */
async function requireEmpty(...dirs: string[]): Promise<void> {
  const entries = await Promise.all(dirs.map(async (dir) => fs.readdir(dir)));
  if (entries.some((list) => list.length > 0)) {
    throw new Error("Private HOME or TMPDIR was modified");
  }
}

/** A direct child of canonical RUNNER_TEMP with our mkdtemp name shape. */
function isRootPathIn(root: string, parent: string): boolean {
  return path.dirname(root) === parent && ROOT_NAME.test(path.basename(root));
}

/** Same device and inode as created, and still a private directory of the same owner. */
function isSameRootDirectory(stat: BigIntStats, owned: Root): boolean {
  return stat.dev === owned.dev && stat.ino === owned.ino && isPrivateDirectory(stat, owned.uid);
}

/** Remove exactly this root, only if it is still the same private directory we created. */
async function removeRoot(owned: Root, runnerTemp: string): Promise<{ removed: string }> {
  const stat = await fs.lstat(owned.root, { bigint: true });
  const parent = await fs.realpath(runnerTemp);
  if (!isRootPathIn(owned.root, parent) || !isSameRootDirectory(stat, owned)) {
    throw new Error(`Root ${owned.root} identity, ownership or mode changed; retained`);
  }
  await fs.rm(owned.root, { recursive: true });
  await requireAbsent(owned.root);
  return { removed: owned.root };
}

async function verifyInRoot(
  owned: Root,
  writer: RecordWriter,
  pin: GatewayReleasePin,
  target: string,
  runnerTemp: string,
) {
  const base = {
    source: `https://github.com/mich-murphy/pi-extensions/releases/download/${gatewayReleaseTag(pin.version)}/`,
    ...pin,
    target,
    root: owned.root,
  };
  let cleanup: "retained" | "cleanup unconfirmed" | "removed" = "retained";
  try {
    await writer.write({ ...base, status: "acquiring" });
    const { home, tmp, installRoot } = await privateProfile(owned.root);
    const result = await acquireGateway(
      {
        approved: true,
        method: "native",
        ...pin,
        target,
        installRoot,
        deadlineMs: Date.now() + ACQUISITION_MS,
        requiredCapabilities: GATEWAY_REMOTE_SETUP_CAPABILITIES,
      },
      { onProgress: (message) => process.stderr.write(`${message}\n`) },
    );
    await requireOwnedExecutable(result.executable, installRoot, result.ownedPaths);
    const installed = await verifyInstalled(result.executable, pin, target);
    const version = verifyVersion(
      jsonObject(JSON.parse(await probeVersion(result.executable, home, tmp))),
      pin.version,
    );
    await requireEmpty(home, tmp);
    const verified = {
      ...base,
      status: "verified",
      executable: path.relative(owned.root, result.executable),
      ...installed,
      gatewayVersion: version,
    };
    await writer.write(verified);
    cleanup = "cleanup unconfirmed"; // a partial rm may fail; only removeRoot returning confirms
    const removed = await removeRoot(owned, runnerTemp);
    cleanup = "removed";
    const done = { ...verified, status: "cleaned", cleanup: removed };
    await writer.write(done);
    return done;
  } catch (error) {
    const failure = new Error(`Root ${owned.root}: ${cleanup}`, { cause: error });
    const retained = cleanup === "retained" ? owned.root : null;
    await recordFailure(writer, { ...base, retained, rootState: cleanup }, failure);
    throw failure;
  }
}

/** Failure evidence names any retained root; a failed record write never hides the cause. */
async function recordFailure(writer: RecordWriter, base: object, error: unknown): Promise<void> {
  try {
    await writer.write({ ...base, status: "failed", error: describe(error) });
  } catch (recordError) {
    // The original failure (which names the root) leads the message; the record error is the cause.
    const message = `${describe(error)}\n  failure record not written`;
    throw new AggregateError([error, recordError], message, { cause: recordError });
  }
}

async function main(target: string, runnerTemp: string, out: string) {
  const pin = requirePin(target);
  // Whatever already exists at `out` is someone else's: never touched.
  const writer = await createRecord(out);
  try {
    let owned: Root;
    try {
      owned = await createRoot(runnerTemp);
    } catch (error) {
      await recordFailure(writer, { ...pin, target, retained: "see error" }, error);
      throw error;
    }
    return await verifyInRoot(owned, writer, pin, target, runnerTemp);
  } finally {
    await writer.close();
  }
}

const { values } = parseArgs({
  options: {
    target: { type: "string" },
    "runner-temp": { type: "string" },
    out: { type: "string" },
  },
});

try {
  const { target, "runner-temp": runnerTemp, out } = values;
  if (
    target === undefined ||
    target === "" ||
    runnerTemp === undefined ||
    runnerTemp === "" ||
    out === undefined ||
    out === ""
  ) {
    throw new Error("Usage: --target T --runner-temp DIR --out RECORD");
  }
  const result = await main(target, runnerTemp, path.resolve(out));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`verify-gateway-native: ${describe(error)}\n`);
  process.exitCode = 1;
}
