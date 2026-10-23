import { createHash } from "node:crypto";
import { check } from "./recall-contract";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Exact UI-only migration. No recognition, selection, allowance or transport changes. */
export function renameTerminologyCommands(source: string): string {
  return source
    .replaceAll('registerCommand("terms', 'registerCommand("terminology')
    .replaceAll("/terms", "/terminology");
}

/** Retain the native source proof; accept only a byte-exact command-name migration. */
export function verifyCommandRenameSource(
  read: (path: string) => string,
  path: string,
  expected: string,
): void {
  const current = read(path);
  if (hash(current) === expected) {
    return;
  }
  check(path === "index.ts" || path === "ui.ts", `Frozen source drift: ${path}`);
  const original = read(`evals/repair/source/${path}.txt`);
  check(
    hash(original) === expected && current === renameTerminologyCommands(original),
    `Frozen source drift beyond command-only rename: ${path}`,
  );
}
