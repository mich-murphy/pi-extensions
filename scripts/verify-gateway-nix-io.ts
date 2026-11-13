/**
 * Descriptor-based file IO for `scripts/verify-gateway-nix.ts`.
 *
 * Reads open with O_NONBLOCK and O_NOFOLLOW. Opening a FIFO then does not wait for a writer, and a
 * final symlink component is refused rather than followed. The descriptor is checked with fstat,
 * so a FIFO, device or other non-regular file is refused before any byte is read. This bounds those
 * opens and refuses non-regular files; it is not a general deadline on kernel or filesystem IO (a
 * stalled network filesystem, for example). Regular-file reads stop at maximum + 1 bytes, so a file
 * that grows while being read is refused rather than read without bound.
 *
 * The record writer keeps the descriptor it exclusively created and never reopens the path, so a
 * replacement at that path is never followed, truncated or renamed over. After each write it checks
 * that the path still names that file. The check and the write are not atomic, and other processes
 * of the same account are not isolated from either.
 */
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import { jsonObject } from "../packages/pi-comms/onboarding/artifact.js";

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CREATE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const CHUNK = 1024 * 1024;
/** Records, markers and the extracted native record are small JSON documents. */
const MAX_JSON = 65_536;

export function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("POSIX account required");
  }
  return uid;
}

/** Same device and inode: the same file, whatever path now names it. */
export function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * `owned`: a regular file owned by this account. `trusted-store`: a regular file not writable by
 * group or other. Nix store files are legitimately owned by root (or the daemon's build user), so
 * the store policy never requires this account's uid.
 */
export type ReadPolicy = "owned" | "trusted-store";

function trustedBy(stat: BigIntStats, policy: ReadPolicy): boolean {
  return policy === "owned" ? stat.uid === BigInt(currentUid()) : (stat.mode & 0o022n) === 0n;
}

export async function readRegular(
  filename: string,
  maximum: number,
  policy: ReadPolicy,
): Promise<{ bytes: Buffer; stat: BigIntStats }> {
  const handle = await fs.open(filename, READ_FLAGS);
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

/** Sequential reads from offset 0, stopping at maximum + 1 bytes so growth is refused, not followed. */
async function readBounded(
  handle: fs.FileHandle,
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

export async function readOwnedJson(filename: string): Promise<Record<string, unknown>> {
  const { bytes } = await readRegular(filename, MAX_JSON, "owned");
  return jsonObject(JSON.parse(bytes.toString("utf8")));
}

export type RecordWriter = {
  /** Replace the record's whole content through the retained descriptor, then prove the path still names it. */
  write: (record: object) => Promise<void>;
  close: () => Promise<void>;
};

/** Positional writes from offset 0 through the retained descriptor until every byte is written. */
async function writeAll(handle: fs.FileHandle, bytes: Buffer, offset: number): Promise<void> {
  if (offset >= bytes.length) {
    return;
  }
  const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
  if (bytesWritten === 0) {
    throw new Error("Record write made no progress");
  }
  await writeAll(handle, bytes, offset + bytesWritten);
}

/** Readers use the path, so fail (never reopen or rename over) if it no longer names our file. */
async function requireStillNamed(filename: string, created: BigIntStats): Promise<void> {
  const visible = await fs.lstat(filename, { bigint: true });
  if (!visible.isFile() || !sameFile(visible, created)) {
    throw new Error(`Record path ${filename} was replaced; this run's record is not visible there`);
  }
}

/** Exclusively create `filename`. Fails, touching nothing, if anything (even a symlink) exists there. */
export async function createRecord(filename: string): Promise<RecordWriter> {
  const handle = await fs.open(filename, CREATE_FLAGS, 0o644);
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
      await requireStillNamed(filename, created);
    },
    close: async () => handle.close(),
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Fails unless `filename` no longer exists. */
export async function requireAbsent(filename: string): Promise<void> {
  try {
    await fs.lstat(filename);
  } catch (error) {
    if (isMissing(error)) {
      return;
    }
    throw error;
  }
  throw new Error(`${filename} still exists after removal`);
}
