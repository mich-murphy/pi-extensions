import { createHash } from "node:crypto";
import { check } from "./recall-contract";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const ORIGINAL_FITTER = "fcb229525aefbc1ee1e20ccf1793c50ef1155d1cd981a26e33be7554211edf81";
const OPTIMIZED_FITTER = "dc6ecf5e445f65023e2a870d11dec94c17291291b775cbf9a764ccb4f889d7b5";

/** Exact UI-only migration. No recognition, selection, allowance or transport changes. */
export function renameTerminologyCommands(source: string): string {
  return source
    .replaceAll('registerCommand("terms', 'registerCommand("terminology')
    .replaceAll("/terms", "/terminology");
}

export function verifyCommandRenameSource(
  read: (path: string) => string,
  path: string,
  expected: string,
): void {
  const current = read(path);
  const currentHash = hash(current);
  if (path === "recall-aggregate-calibration.ts") {
    check(
      expected === ORIGINAL_FITTER &&
        hash(read(`evals/repair/source/${path}.txt`)) === ORIGINAL_FITTER &&
        (currentHash === ORIGINAL_FITTER || currentHash === OPTIMIZED_FITTER),
      `Frozen source drift beyond pinned optimizer: ${path}`,
    );
    return;
  }
  if (currentHash === expected) {
    return;
  }
  check(path === "index.ts" || path === "ui.ts", `Frozen source drift: ${path}`);
  const original = read(`evals/repair/source/${path}.txt`);
  check(
    hash(original) === expected && current === renameTerminologyCommands(original),
    `Frozen source drift beyond command-only rename: ${path}`,
  );
}
