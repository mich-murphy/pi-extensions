import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { Predicate, Schema } from "effect";
import {
  GATEWAY_MANAGED_CAPABILITY,
  GATEWAY_REMOTE_SETUP_CAPABILITIES,
  GATEWAY_WIRE_VERSION,
  wireMismatch,
} from "../packages/pi-peers/onboarding/catalog.js";

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const CREATE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

const CHUNK = 1024 * 1024;
const MAX_JSON = 65_536;

export function currentUid(): number {
  const uid = process.getuid?.();

  if (uid === undefined) {
    throw new Error("POSIX account required");
  }

  return uid;
}

export function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

export type ReadPolicy = "owned" | "trusted-store";

function trustedBy(stat: BigIntStats, policy: ReadPolicy): boolean {
  return policy === "owned" ? stat.uid === BigInt(currentUid()) : (stat.mode & 0o022n) === 0n;
}

export async function readRegular(
  filename: string,
  maximum: number,
  policy: ReadPolicy,
): Promise<{ bytes: Buffer; stat: BigIntStats }> {
  const handle = await open(filename, READ_FLAGS);

  try {
    const stat = await handle.stat({ bigint: true });

    if (!stat.isFile() || !trustedBy(stat, policy) || stat.size > BigInt(maximum)) {
      throw new Error(
        `Refusing ${policy} read of untrusted, non-regular or large file ${filename}`,
      );
    }

    return { bytes: await readBounded(handle, filename, maximum, []), stat };
  } finally {
    await handle.close();
  }
}

async function readBounded(
  handle: FileHandle,
  filename: string,
  maximum: number,
  chunks: Buffer[],
): Promise<Buffer> {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);

  if (total > maximum) {
    throw new Error(`File ${filename} grew beyond ${maximum} bytes while being read`);
  }

  const chunk = Buffer.allocUnsafe(Math.min(CHUNK, maximum + 1 - total));
  const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);

  if (bytesRead === 0) {
    return Buffer.concat(chunks, total);
  }

  return readBounded(handle, filename, maximum, [...chunks, chunk.subarray(0, bytesRead)]);
}

const isRecordJson = Schema.is(Schema.JsonObject);

export function parseRecordJson(source: string): Schema.JsonObject {
  const record: unknown = JSON.parse(source);

  if (!isRecordJson(record)) {
    throw new Error("Invalid JSON object");
  }

  return record;
}

export async function readOwnedJson(filename: string) {
  const { bytes } = await readRegular(filename, MAX_JSON, "owned");

  return parseRecordJson(bytes.toString("utf8"));
}

export type RecordWriter = {
  write: (record: typeof Schema.JsonObject.Type) => Promise<void>;
  close: () => Promise<void>;
};

async function writeAll(handle: FileHandle, bytes: Buffer, offset: number): Promise<void> {
  if (offset >= bytes.length) {
    return;
  }

  const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);

  if (bytesWritten === 0) {
    throw new Error("Record write made no progress");
  }

  await writeAll(handle, bytes, offset + bytesWritten);
}

async function requireStillNamedCheckedNonAtomicallyAfterWrite(
  filename: string,
  created: BigIntStats,
): Promise<void> {
  const visible = await lstat(filename, { bigint: true });

  if (!visible.isFile() || !sameFile(visible, created)) {
    throw new Error(`Record path ${filename} was replaced; this run's record is not visible there`);
  }
}

export async function createRecord(filename: string): Promise<RecordWriter> {
  const handle = await open(filename, CREATE_FLAGS, 0o644);
  let created: BigIntStats;

  try {
    created = await handle.stat({ bigint: true });
  } catch (error) {
    await handle.close();
    throw error;
  }

  return {
    write: async (record) => {
      await handle.truncate(0);
      await writeAll(handle, Buffer.from(`${JSON.stringify(record, null, 2)}\n`), 0);
      await requireStillNamedCheckedNonAtomicallyAfterWrite(filename, created);
    },
    close: async () => handle.close(),
  };
}

export async function requireAbsent(filename: string): Promise<void> {
  try {
    await lstat(filename);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  throw new Error(`${filename} still exists after removal`);
}

export function isPrivateDirectory(stat: BigIntStats, uid: number): boolean {
  return stat.isDirectory() && stat.uid === BigInt(uid) && (stat.mode & 0o077n) === 0n;
}

export async function privateProfile(root: string) {
  const dirs = {
    home: path.join(root, "home"),
    tmp: path.join(root, "tmp"),
    installRoot: path.join(root, "install"),
  };

  await Promise.all(Object.values(dirs).map(async (dir) => mkdir(dir, { mode: 0o700 })));
  process.env.HOME = dirs.home;
  process.env.TMPDIR = dirs.tmp;

  return dirs;
}

const isVersionList = Schema.is(Schema.Array(Schema.Json));
const REQUIRED_CAPABILITIES = [GATEWAY_MANAGED_CAPABILITY, ...GATEWAY_REMOTE_SETUP_CAPABILITIES];

export function verifyGatewayVersion(record: Schema.JsonObject, expected: string, source: string) {
  const { name, version, wireVersions, capabilities } = record;
  const mismatch = `${source} gateway ABI/capability mismatch`;

  if (name !== "pi-gateway" || version !== expected) {
    throw new Error(mismatch);
  }

  if (!isVersionList(wireVersions) || !wireVersions.includes(GATEWAY_WIRE_VERSION)) {
    throw new Error(wireMismatch(source, expected, wireVersions));
  }

  if (
    !isVersionList(capabilities) ||
    !REQUIRED_CAPABILITIES.every((capability) => capabilities.includes(capability))
  ) {
    throw new Error(mismatch);
  }

  return { name, version, wireVersions, capabilities };
}

const isString = Schema.is(Schema.String);
const isSymbol = Schema.is(Schema.Symbol);
const isFunction = Schema.is(Schema.declare(Predicate.isFunction));
const nestedErrors = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown));

export function describeFailure(cause: unknown, includeAggregates: boolean): string {
  const pending = [cause];
  const messages: string[] = [];

  while (pending.length > 0 && messages.length < 8) {
    const item = pending.shift();

    if (item === undefined) {
      continue;
    }

    if (item instanceof Error) {
      messages.push(item.message);
      pending.push(item.cause, ...aggregateMembers(item, includeAggregates));
    } else if (includeAggregates && isString(item)) {
      messages.push(item);
    } else {
      const json = JSON.stringify(item);
      messages.push(json ?? (isSymbol(item) ? "symbol" : fallbackKind(isFunction(item))));
    }
  }

  return messages
    .join("\n  caused by: ")
    .replaceAll(/\b(?:gh[opsur]|github_pat)_[A-Za-z0-9_]+/gu, "[redacted]")
    .slice(0, 8000);
}

function aggregateMembers(error: Error, includeAggregates: boolean) {
  return includeAggregates && error instanceof AggregateError ? nestedErrors(error.errors) : [];
}

function fallbackKind(callable: boolean): string {
  return callable ? "function" : "object";
}
