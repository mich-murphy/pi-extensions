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
import { SETTINGS_CHANGED } from "./refusal.js";

export async function replaceOwned(path: string, expected: string, content: string): Promise<void> {
  const bytes = await regularBytes(path);

  if (bytes === undefined || digest(bytes) !== expected) {
    throw SETTINGS_CHANGED();
  }

  const temporary = `${path}.staged-${randomBytes(12).toString("hex")}`;
  await createPrivate(temporary, content);
  const backup = `${path}.previous-${randomBytes(12).toString("hex")}`;
  await link(path, backup);
  await syncDirectory(join(path, ".."));
  const current = await regularBytes(path);

  if (current === undefined || digest(current) !== expected) {
    throw SETTINGS_CHANGED();
  }

  await rename(temporary, path);
}
