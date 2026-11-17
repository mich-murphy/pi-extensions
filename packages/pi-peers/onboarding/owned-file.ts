import { randomBytes } from "node:crypto";
import { link } from "node:fs/promises";
import { join } from "node:path";
import {
  createPrivate,
  digest,
  regularBytes,
  durableRename as rename,
  syncDirectory,
} from "./files.js";

/** Reviewed owned projection update. Preserve old snapshots and refuse symlinks/concurrent edits. */
export async function replaceOwned(path: string, expected: string, content: string): Promise<void> {
  const bytes = await regularBytes(path);
  if (bytes === undefined || digest(bytes) !== expected) {
    throw new Error("Owned configuration changed; update refused");
  }
  const temporary = `${path}.staged-${randomBytes(12).toString("hex")}`;
  await createPrivate(temporary, content);
  // A create-only hardlink preserves the exact inode before replacement, not an external path's later bytes.
  const backup = `${path}.previous-${randomBytes(12).toString("hex")}`;
  await link(path, backup);
  await syncDirectory(join(path, ".."));
  const current = await regularBytes(path);
  if (current === undefined || digest(current) !== expected) {
    throw new Error("Concurrent edit; staged files preserved for recovery");
  }
  await rename(temporary, path);
}
