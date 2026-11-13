import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { GATEWAY_REMOTE_SETUP_CAPABILITIES } from "./catalog.js";
import { createPrivate } from "./files.js";
import { gatewayEnvironment, validateExecutable } from "./managed.js";
import { decodeRecord, decodeCredentials, parseJson } from "./schema.js";
import type { credentialSchema } from "./schema.js";

const execute = promisify(execFile);
export type PairOperation =
  | "import-existing"
  | "create"
  | "join"
  | "issue"
  | "import"
  | "renew"
  | "revoke"
  | "export"
  | "inspect";
/** Agreed native contract: private bounded input file, public-only bounded JSON output. */
export async function pairAction(
  executable: string,
  directory: string,
  operation: PairOperation,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!isAbsolute(executable) || !isAbsolute(directory)) {
    throw new Error("Pairing paths must be absolute");
  }
  await validateExecutable(executable, GATEWAY_REMOTE_SETUP_CAPABILITIES);
  const path = join(directory, `pair-input-${randomBytes(16).toString("hex")}.json`);
  const bytes = JSON.stringify(input);
  if (Buffer.byteLength(bytes) > 32_764) {
    throw new Error("Pairing input too large");
  }
  await createPrivate(path, bytes);
  try {
    const { stdout } = await execute(executable, ["pair", operation, "--input", path], {
      timeout: 15_000,
      maxBuffer: 32_768,
      env: gatewayEnvironment(),
    });
    const output = decodeRecord(parseJson(stdout));
    if (output.version !== 1 || output.operation !== operation) {
      throw new Error("Pairing contract mismatch");
    }
    return output;
  } finally {
    await unlink(path);
  }
}
export type Credentials = typeof credentialSchema.Type;
export function credentials(value: unknown): Credentials {
  return decodeCredentials(value);
}
