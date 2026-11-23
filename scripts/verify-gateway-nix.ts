import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { acquireGateway, discoverNixExecutable } from "../packages/pi-peers/onboarding/acquire.js";
import { MAX_BINARY, jsonObject, sha256 } from "../packages/pi-peers/onboarding/artifact.js";
import {
  GATEWAY_MANAGED_CAPABILITY,
  GATEWAY_REMOTE_SETUP_CAPABILITIES,
  GATEWAY_WIRE_VERSION,
  gatewayCatalog,
  gatewayTarget,
} from "../packages/pi-peers/onboarding/catalog.js";
import {
  createRecord,
  currentUid,
  readOwnedJson,
  readRegular,
  requireAbsent,
  sameFile,
} from "./verify-gateway-nix-io.js";
import type { RecordWriter } from "./verify-gateway-nix-io.js";

const ROOT_NAME = /^gateway-nix-[A-Za-z0-9]{6}$/u;
const STORE_EXECUTABLE = /^\/nix\/store\/[a-z0-9]{32}-[^/]+\/bin\/pi-gateway$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const NONCE = /^[a-f0-9]{32}$/u;
const ACQUISITION_MS = 600_000;
const REQUIRED_CAPABILITIES = [GATEWAY_MANAGED_CAPABILITY, ...GATEWAY_REMOTE_SETUP_CAPABILITIES];
const IDENTITY_KEYS = ["root", "dev", "ino", "uid", "nonce"] as const;

type Identity = { root: string; dev: string; ino: string; uid: number; nonce: string };
type NixRecord = Identity & { executable: string; binarySha256: string };
type NixPin = NonNullable<typeof gatewayCatalog.nix>;

async function canonicalTemp(runnerTemp: string): Promise<string> {
  if (!path.isAbsolute(runnerTemp)) {
    throw new Error("--runner-temp must be absolute");
  }
  return fs.realpath(runnerTemp);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function isPrivateDirectory(stat: BigIntStats, uid: number): boolean {
  return stat.isDirectory() && stat.uid === BigInt(uid) && (stat.mode & 0o077n) === 0n;
}

async function readStoreExecutable(executable: string): Promise<Buffer> {
  if (!STORE_EXECUTABLE.test(executable)) {
    throw new Error("Not a Nix store gateway executable");
  }
  const { bytes } = await readRegular(executable, MAX_BINARY, "trusted-store");
  return bytes;
}

async function run(file: string, args: string[], home: string): Promise<string> {
  const { stdout } = await promisify(execFile)(file, args, {
    timeout: 10_000,
    maxBuffer: 65_536,
    env: { HOME: home, TMPDIR: home, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  });
  return stdout;
}

function messageOf(item: unknown): string {
  if (item instanceof Error) {
    return item.message;
  }
  return typeof item === "string" ? item : (JSON.stringify(item) ?? typeof item);
}

function causesOf(item: unknown): unknown[] {
  const aggregated = item instanceof AggregateError ? (item.errors as unknown[]) : [];
  const causes = item instanceof Error ? [item.cause, ...aggregated] : [];
  return causes.filter((cause) => cause !== undefined);
}

function collectMessages(pending: unknown[], messages: string[]): string[] {
  if (pending.length === 0 || messages.length >= 8) {
    return messages;
  }
  const [item, ...rest] = pending;
  return collectMessages([...rest, ...causesOf(item)], [...messages, messageOf(item)]);
}

function describe(error: unknown): string {
  return collectMessages(
    [error].filter((item) => item !== undefined),
    [],
  )
    .join("\n  caused by: ")
    .replaceAll(/\b(?:gh[opsur]|github_pat)_[A-Za-z0-9_]+/gu, "[redacted]")
    .slice(0, 8000);
}

async function namingRoot<T>(root: string, step: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw new Error(`${step}; owned Nix root ${root} retained`, { cause: error });
  }
}

async function createOwnedRoot(runnerTemp: string, out: string) {
  const root = await fs.mkdtemp(path.join(await canonicalTemp(runnerTemp), "gateway-nix-"));
  const stat = await namingRoot(root, "Cannot inspect fresh root", async () =>
    fs.lstat(root, { bigint: true }),
  );
  if (!isPrivateDirectory(stat, currentUid())) {
    throw new Error(`Fresh Nix root ${root} is not private; retained`);
  }
  const identity: Identity = {
    root,
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: currentUid(),
    nonce: randomBytes(16).toString("hex"),
  };
  await namingRoot(root, "Cannot create owner marker", async () =>
    fs.writeFile(path.join(root, "owner.json"), JSON.stringify(identity), {
      flag: "wx",
      mode: 0o400,
    }),
  );
  const writer: RecordWriter = await namingRoot(
    root,
    `Cannot exclusively create record ${out}`,
    async () => createRecord(out),
  );
  return { identity, writer };
}

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

async function acquireThroughNix(pin: NixPin, target: string, installRoot: string) {
  const nixExecutable = await discoverNixExecutable();
  if (nixExecutable === undefined) {
    throw new Error("No trusted system Nix executable discovered");
  }
  const result = await acquireGateway(
    {
      approved: true,
      method: "nix",
      sourceRevision: pin.sourceRevision,
      version: pin.version,
      narHash: pin.narHash,
      target,
      installRoot,
      nixExecutable,
      deadlineMs: Date.now() + ACQUISITION_MS,
      requiredCapabilities: GATEWAY_REMOTE_SETUP_CAPABILITIES,
    },
    {
      onProgress: (message) => {
        process.stderr.write(`${message}\n`);
      },
    },
  );
  return { nixExecutable, result };
}

function isPinnedGateway(version: Record<string, unknown>, expected: string): boolean {
  return version.name === "pi-gateway" && version.version === expected;
}

function speaksWire(version: Record<string, unknown>): boolean {
  return Array.isArray(version.wireVersions) && version.wireVersions.includes(GATEWAY_WIRE_VERSION);
}

function hasRequiredCapabilities(version: Record<string, unknown>): boolean {
  const capabilities: unknown[] = Array.isArray(version.capabilities) ? version.capabilities : [];
  return REQUIRED_CAPABILITIES.every((capability) => capabilities.includes(capability));
}

function verifyGatewayVersion(version: Record<string, unknown>, expected: string): void {
  if (
    !isPinnedGateway(version, expected) ||
    !speaksWire(version) ||
    !hasRequiredCapabilities(version)
  ) {
    throw new Error("Acquired Nix gateway ABI/capability mismatch");
  }
}

async function probeAcquired(executable: string, nix: string, home: string, expected: string) {
  const binary = await readStoreExecutable(executable);
  const version = jsonObject(JSON.parse(await run(executable, ["--version", "--json"], home)));
  const nixVersion = await run(nix, ["--version"], home);
  verifyGatewayVersion(version, expected);
  return {
    nixVersion: nixVersion.trim(),
    executable,
    binarySha256: sha256(binary),
    binarySize: binary.length,
    gatewayVersion: version,
  };
}

async function recordFailure(writer: RecordWriter, base: Identity, error: unknown) {
  try {
    await writer.write({
      ...base,
      status: "failed",
      retained: "root kept for runner teardown",
      error: describe(error),
    });
  } catch (recordError) {
    throw new AggregateError([error, recordError], `Nix root ${base.root} retained`, {
      cause: recordError,
    });
  }
}

async function acquireInRoot(
  identity: Identity,
  writer: RecordWriter,
  pin: NixPin,
  target: string,
): Promise<object> {
  const base = { ...identity, target, ...pin };
  await namingRoot(identity.root, "Cannot write preparing record", async () =>
    writer.write({ ...base, status: "preparing" }),
  );
  try {
    const { home, installRoot } = await privateProfile(identity.root);
    const { nixExecutable, result } = await acquireThroughNix(pin, target, installRoot);
    const probed = await probeAcquired(result.executable, nixExecutable, home, pin.version);
    const acquired = {
      ...base,
      status: "acquired",
      nixExecutable,
      ...probed,
      ownedPaths: result.ownedPaths,
      recoveryEffects: result.recoveryEffects,
    };
    await writer.write(acquired);
    return acquired;
  } catch (error) {
    await recordFailure(writer, base, error);
    throw error;
  }
}

async function prepare(target: string, runnerTemp: string, out: string): Promise<object> {
  const pin = gatewayCatalog.nix;
  if (gatewayTarget() !== target) {
    throw new Error(`Host target ${gatewayTarget()} does not match matrix target ${target}`);
  }
  if (pin === null) {
    throw new Error("Default catalog has no Nix pin");
  }
  const { identity, writer } = await createOwnedRoot(runnerTemp, out);
  try {
    return await acquireInRoot(identity, writer, pin, target);
  } finally {
    await writer.close();
  }
}

function namesOwnedRoot(root: unknown, runnerTemp: string): root is string {
  return (
    typeof root === "string" &&
    path.dirname(root) === runnerTemp &&
    ROOT_NAME.test(path.basename(root))
  );
}

function isRunNonce(nonce: unknown): nonce is string {
  return typeof nonce === "string" && NONCE.test(nonce);
}

function recordSchema(record: Record<string, unknown>, runnerTemp: string) {
  const { root, uid, nonce } = record;
  if (!namesOwnedRoot(root, runnerTemp) || uid !== currentUid() || !isRunNonce(nonce)) {
    throw new Error("Record does not name an owned Nix root");
  }
  return { root, uid: currentUid(), nonce };
}

async function rootIdentity(root: string, uid: number, record: Record<string, unknown>) {
  const stat = await fs.lstat(root, { bigint: true });
  const dev = String(stat.dev);
  const ino = String(stat.ino);
  if (!isPrivateDirectory(stat, uid) || record.dev !== dev || record.ino !== ino) {
    throw new Error("Nix root identity, ownership or mode changed");
  }
  return { dev, ino };
}

async function requireMarker(identity: Identity): Promise<void> {
  const marker = await readOwnedJson(path.join(identity.root, "owner.json"));
  if (IDENTITY_KEYS.some((key) => marker[key] !== identity[key])) {
    throw new Error("Nix root marker does not match record");
  }
}

function acquiredState(record: Record<string, unknown>) {
  const { status, executable, binarySha256 } = record;
  if (status !== "acquired" || typeof executable !== "string" || !isSha256(binarySha256)) {
    throw new Error(`Nix record is not an acquired run (status ${String(status)})`);
  }
  return { executable, binarySha256 };
}

async function ownedRecord(recordPath: string, runnerTemp: string): Promise<NixRecord> {
  const record = await readOwnedJson(recordPath);
  const named = recordSchema(record, await canonicalTemp(runnerTemp));
  const identity: Identity = { ...named, ...(await rootIdentity(named.root, named.uid, record)) };
  await requireMarker(identity);
  return { ...identity, ...acquiredState(record) };
}

async function storeBinary(record: NixRecord): Promise<Buffer> {
  const binary = await readStoreExecutable(record.executable);
  if (sha256(binary) !== record.binarySha256) {
    throw new Error("Nix store executable differs from this run's record");
  }
  return binary;
}

async function expectedNative(extractedPath: string): Promise<string> {
  const { binarySha256 } = await readOwnedJson(extractedPath);
  if (!isSha256(binarySha256)) {
    throw new Error("Invalid extracted native record");
  }
  return binarySha256;
}

function isWriterPrivate(stat: BigIntStats): boolean {
  return stat.isDirectory() && stat.uid === BigInt(currentUid()) && (stat.mode & 0o022n) === 0n;
}

async function requireFixtureParent(fixture: string): Promise<void> {
  const parentPath = path.dirname(fixture);
  const parent = await fs.lstat(parentPath, { bigint: true });
  const canonical = await fs.realpath(parentPath);
  if (canonical !== parentPath || !isWriterPrivate(parent)) {
    throw new Error("Fixture directory is not canonical, owned and private from other writers");
  }
}

async function replaceFixture(fixture: string, verified: BigIntStats, binary: Buffer) {
  const again = await fs.lstat(fixture, { bigint: true });
  if (!sameFile(again, verified)) {
    throw new Error("Fixture changed while being verified");
  }
  await fs.unlink(fixture);
  await fs.writeFile(fixture, binary, { flag: "wx", mode: 0o500 });
}

async function installFixture(record: NixRecord, extractedPath: string, fixture: string) {
  const expected = await expectedNative(extractedPath);
  await requireFixtureParent(fixture);
  const current = await readRegular(fixture, MAX_BINARY, "owned");
  if (sha256(current.bytes) !== expected) {
    throw new Error("Fixture is not the authenticated native binary; refusing to replace");
  }
  await replaceFixture(fixture, current.stat, await storeBinary(record));
  return { fixture, replacedSha256: expected, ...(await verifyFixture(record, fixture)) };
}

async function verifyFixture(record: NixRecord, fixture: string) {
  await storeBinary(record);
  const { bytes, stat } = await readRegular(fixture, MAX_BINARY, "owned");
  if (sha256(bytes) !== record.binarySha256 || (stat.mode & 0o777n) !== 0o500n) {
    throw new Error("Fixture is not this run's Nix binary with mode 0500");
  }
  return { fixtureSha256: record.binarySha256, mode: "0500", storeExecutable: record.executable };
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: Object.fromEntries(
    ["target", "runner-temp", "out", "record", "extracted", "fixture"].map((name) => [
      name,
      { type: "string" as const },
    ]),
  ),
});
function option(name: string): string {
  const value = values[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing --${name}`);
  }
  return value;
}
async function owned(): Promise<NixRecord> {
  return ownedRecord(option("record"), option("runner-temp"));
}

const commands = new Map<string, () => Promise<unknown>>([
  ["prepare", async () => prepare(option("target"), option("runner-temp"), option("out"))],
  [
    "install-fixture",
    async () => installFixture(await owned(), option("extracted"), path.resolve(option("fixture"))),
  ],
  ["verify-fixture", async () => verifyFixture(await owned(), path.resolve(option("fixture")))],
  [
    "cleanup",
    async () => {
      const { root } = await owned();
      await fs.rm(root, { recursive: true });
      await requireAbsent(root);
      return { removed: root };
    },
  ],
]);

function selectCommand(args: string[]): () => Promise<unknown> {
  const [command = "", ...extra] = args;
  const handler = commands.get(command);
  if (handler === undefined || extra.length > 0) {
    throw new Error("Usage: prepare | install-fixture | verify-fixture | cleanup [--options]");
  }
  return handler;
}

try {
  const result = await selectCommand(positionals)();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`verify-gateway-nix: ${describe(error)}\n`);
  process.exitCode = 1;
}
