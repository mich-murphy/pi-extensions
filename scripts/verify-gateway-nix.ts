import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { Option, Schema } from "effect";
import { acquireGateway, discoverNixExecutable } from "../packages/pi-peers/onboarding/acquire.js";
import { MAX_BINARY, sha256 } from "../packages/pi-peers/onboarding/artifact.js";
import {
  GATEWAY_REMOTE_SETUP_CAPABILITIES,
  gatewayCatalog,
  gatewayTarget,
} from "../packages/pi-peers/onboarding/catalog.js";
import {
  createRecord,
  currentUid,
  describeFailure,
  isPrivateDirectory,
  parseRecordJson,
  privateProfile,
  readOwnedJson,
  readRegular,
  requireAbsent,
  sameFile,
  verifyGatewayVersion,
} from "./verify-gateway-nix-io.js";
import type { RecordWriter } from "./verify-gateway-nix-io.js";

const ROOT_NAME = /^gateway-nix-[A-Za-z0-9]{6}$/u;
const STORE_EXECUTABLE = /^\/nix\/store\/[a-z0-9]{32}-[^/]+\/bin\/pi-gateway$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const NONCE = /^[a-f0-9]{32}$/u;
const ACQUISITION_MS = 600_000;
const IDENTITY_KEYS = ["root", "dev", "ino", "uid", "nonce"] as const;

type Identity = typeof Identity.Type;

type NixRecord = Identity & { executable: string; binarySha256: string };

type NixPin = NonNullable<typeof gatewayCatalog.nix>;

async function canonicalTemp(runnerTemp: string): Promise<string> {
  if (!path.isAbsolute(runnerTemp)) {
    throw new Error("--runner-temp must be absolute");
  }

  return realpath(runnerTemp);
}

async function readStoreExecutable(executable: string): Promise<Buffer> {
  if (!STORE_EXECUTABLE.test(executable)) {
    throw new Error("Not a Nix store gateway executable");
  }

  const { bytes } = await readRegular(executable, MAX_BINARY, "trusted-store");

  return bytes;
}

async function run(file: string, args: Array<string>, home: string): Promise<string> {
  const { stdout } = await promisify(execFile)(file, args, {
    timeout: 10_000,
    maxBuffer: 65_536,
    env: { HOME: home, TMPDIR: home, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  });

  return stdout;
}

async function namingRoot<T>(root: string, step: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw new Error(`${step}; owned Nix root ${root} retained`, { cause: error });
  }
}

async function createOwnedRoot(runnerTemp: string, out: string) {
  const root = await mkdtemp(path.join(await canonicalTemp(runnerTemp), "gateway-nix-"));

  const stat = await namingRoot(root, "Cannot inspect fresh root", async () =>
    lstat(root, { bigint: true }),
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
    writeFile(path.join(root, "owner.json"), JSON.stringify(identity), {
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

async function probeAcquired(executable: string, nix: string, home: string, expected: string) {
  const binary = await readStoreExecutable(executable);
  const version = parseRecordJson(await run(executable, ["--version", "--json"], home));
  const nixVersion = await run(nix, ["--version"], home);
  verifyGatewayVersion(version, expected, "Acquired Nix");

  return {
    nixVersion: nixVersion.trim(),
    executable,
    binarySha256: sha256(binary),
    binarySize: binary.length,
    gatewayVersion: version,
  };
}

async function recordFailure(writer: RecordWriter, base: Identity, cause: unknown) {
  try {
    await writer.write({
      ...base,
      status: "failed",
      retained: "root kept for runner teardown",
      error: describeFailure(cause, true),
    });
  } catch (recordError) {
    throw new AggregateError([cause, recordError], `Nix root ${base.root} retained`, {
      cause: recordError,
    });
  }
}

async function acquireInRoot(
  identity: Identity,
  writer: RecordWriter,
  pin: NixPin,
  target: string,
) {
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

async function prepare(target: string, runnerTemp: string, out: string) {
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

const OwnedRoot = Schema.Struct({
  root: Schema.String,
  uid: Schema.Number,
  nonce: Schema.String.check(Schema.isPattern(NONCE)),
});

const Identity = Schema.Struct({ ...OwnedRoot.fields, dev: Schema.String, ino: Schema.String });
const decodeOwnedRoot = Schema.decodeUnknownOption(OwnedRoot);
const decodeIdentity = Schema.decodeUnknownOption(Identity);
const BinaryDigest = Schema.String.check(Schema.isPattern(SHA256));

const decodeAcquired = Schema.decodeUnknownOption(
  Schema.Struct({
    status: Schema.Literal("acquired"),
    executable: Schema.String,
    binarySha256: BinaryDigest,
  }),
);

const decodeExtracted = Schema.decodeUnknownOption(Schema.Struct({ binarySha256: BinaryDigest }));

function namesOwnedRoot(root: string, runnerTemp: string): boolean {
  return path.dirname(root) === runnerTemp && ROOT_NAME.test(path.basename(root));
}

function recordRoot(record: Schema.JsonObject, runnerTemp: string) {
  const named = Option.getOrUndefined(decodeOwnedRoot(record));

  if (
    named === undefined ||
    !namesOwnedRoot(named.root, runnerTemp) ||
    named.uid !== currentUid()
  ) {
    throw new Error("Record does not name an owned Nix root");
  }

  return named;
}

type RecordedFileIdentity = { dev: Schema.Json | undefined; ino: Schema.Json | undefined };

async function rootIdentity(root: string, uid: number, recorded: RecordedFileIdentity) {
  const stat = await lstat(root, { bigint: true });
  const dev = String(stat.dev);
  const ino = String(stat.ino);

  if (!isPrivateDirectory(stat, uid) || recorded.dev !== dev || recorded.ino !== ino) {
    throw new Error("Nix root identity, ownership or mode changed");
  }

  return { dev, ino };
}

async function requireMarker(identity: Identity): Promise<void> {
  const raw = await readOwnedJson(path.join(identity.root, "owner.json"));
  const marker = Option.getOrUndefined(decodeIdentity(raw));

  if (marker === undefined || IDENTITY_KEYS.some((key) => marker[key] !== identity[key])) {
    throw new Error("Nix root marker does not match record");
  }
}

const isStatusScalar = Schema.is(
  Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null, Schema.Undefined]),
);

const isStatusList = Schema.is(Schema.Array(Schema.Json));

function statusText(value: Schema.Json | undefined): string {
  if (isStatusScalar(value)) {
    return String(value);
  }

  return isStatusList(value)
    ? value.map((item) => (item === null ? "" : statusText(item))).join(",")
    : "[object Object]";
}

function acquiredState(record: Schema.JsonObject) {
  const acquired = Option.getOrUndefined(decodeAcquired(record));

  if (acquired === undefined) {
    throw new Error(`Nix record is not an acquired run (status ${statusText(record.status)})`);
  }

  const { executable, binarySha256 } = acquired;

  return { executable, binarySha256 };
}

async function ownedRecord(recordPath: string, runnerTemp: string): Promise<NixRecord> {
  const record = await readOwnedJson(recordPath);
  const named = recordRoot(record, await canonicalTemp(runnerTemp));
  const { dev, ino } = record;
  const identity = { ...named, ...(await rootIdentity(named.root, named.uid, { dev, ino })) };
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
  const extracted = Option.getOrUndefined(decodeExtracted(await readOwnedJson(extractedPath)));

  if (extracted === undefined) {
    throw new Error("Invalid extracted native record");
  }

  return extracted.binarySha256;
}

function isWriterPrivate(stat: BigIntStats): boolean {
  return stat.isDirectory() && stat.uid === BigInt(currentUid()) && (stat.mode & 0o022n) === 0n;
}

async function requireFixtureParent(fixture: string): Promise<void> {
  const parentPath = path.dirname(fixture);
  const parent = await lstat(parentPath, { bigint: true });
  const canonical = await realpath(parentPath);

  if (canonical !== parentPath || !isWriterPrivate(parent)) {
    throw new Error("Fixture directory is not canonical, owned and private from other writers");
  }
}

async function replaceFixture(fixture: string, verified: BigIntStats, binary: Buffer) {
  const again = await lstat(fixture, { bigint: true });

  if (!sameFile(again, verified)) {
    throw new Error("Fixture changed while being verified");
  }

  await unlink(fixture);
  await writeFile(fixture, binary, { flag: "wx", mode: 0o500 });
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
  options: {
    target: { type: "string" },
    "runner-temp": { type: "string" },
    out: { type: "string" },
    record: { type: "string" },
    extracted: { type: "string" },
    fixture: { type: "string" },
  },
});

function option(name: keyof typeof values): string {
  const value = values[name];

  if (value === undefined || value.length === 0) {
    throw new Error(`Missing --${name}`);
  }

  return value;
}

async function owned(): Promise<NixRecord> {
  return ownedRecord(option("record"), option("runner-temp"));
}

type Command = () => Promise<Schema.JsonObject>;

const commands = new Map<string, Command>([
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
      await rm(root, { recursive: true });
      await requireAbsent(root);

      return { removed: root };
    },
  ],
]);

function selectCommand(args: Array<string>): Command {
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
  process.stderr.write(`verify-gateway-nix: ${describeFailure(error, true)}\n`);
  process.exitCode = 1;
}
