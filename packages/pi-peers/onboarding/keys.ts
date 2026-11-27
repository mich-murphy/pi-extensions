import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { errnoCode } from "../../shared/errno.js";
import { GATEWAY_REMOTE_SETUP_CAPABILITIES } from "./catalog.js";
import { createPrivate, durableUnlink, privateDirectory, regularBytes } from "./files.js";
import { gatewayEnvironment, validateExecutable } from "./managed.js";
import { parseJson } from "./schema.js";

const execute = promisify(execFile);

const PUBLIC_KEY = /^[a-f0-9]{64}$/u;

export type KeyOperation = "generate" | "show";

const decodeReply = Schema.decodeUnknownSync(
  Schema.Struct({
    version: Schema.Literal(1),
    operation: Schema.Literals(["generate", "show"]),
    publicKey: Schema.String.check(Schema.isPattern(PUBLIC_KEY)),
  }),
  { onExcessProperty: "error" },
);

export function keyPaths(setupDirectory: string) {
  const directory = join(setupDirectory, "keys");

  return {
    directory,
    privateKey: join(directory, "gateway-key.der"),
    publicKey: join(directory, "gateway-key.pub"),
  };
}

export async function keyAction(
  executable: string,
  directory: string,
  operation: KeyOperation,
  privateKey: string,
): Promise<string> {
  if (!isAbsolute(executable) || !isAbsolute(directory) || !isAbsolute(privateKey)) {
    throw new Error("Key paths must be absolute");
  }

  await validateExecutable(executable, GATEWAY_REMOTE_SETUP_CAPABILITIES);
  const bytes = JSON.stringify({ version: 1, privateKey });

  if (Buffer.byteLength(bytes) > 32_764) {
    throw new Error("The key path is too long");
  }

  const input = join(directory, `key-input-${randomBytes(16).toString("hex")}.json`);
  await createPrivate(input, bytes);

  try {
    const { stdout } = await execute(executable, ["key", operation, "--input", input], {
      timeout: 15_000,
      maxBuffer: 4096,
      env: gatewayEnvironment(),
    });

    const reply = decodeReply(parseJson(stdout));

    if (reply.operation !== operation) {
      throw new Error("The gateway program gave an unexpected key reply");
    }

    return reply.publicKey;
  } finally {
    await unlink(input);
  }
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);

    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function savePublic(path: string, key: string): Promise<void> {
  const saved = await regularBytes(path);
  const text = `${key}\n`;

  if (saved?.toString("utf8") === text) {
    return;
  }

  if (saved !== undefined) {
    await durableUnlink(path);
  }

  await createPrivate(path, text);
}

export async function ensureKey(executable: string, setupDirectory: string): Promise<string> {
  const paths = keyPaths(setupDirectory);
  await privateDirectory(paths.directory);
  const operation = (await present(paths.privateKey)) ? "show" : "generate";
  const key = await keyAction(executable, paths.directory, operation, paths.privateKey);
  await savePublic(paths.publicKey, key);

  return key;
}

export async function savedKey(setupDirectory: string): Promise<string | undefined> {
  const paths = keyPaths(setupDirectory);

  if (!(await present(paths.privateKey))) {
    return undefined;
  }

  const bytes = await regularBytes(paths.publicKey);
  const text = bytes?.toString("utf8").trim() ?? "";

  return PUBLIC_KEY.test(text) ? text : undefined;
}

export function peerKeyError(value: string, own: string): string | undefined {
  const key = value.trim();

  if (!PUBLIC_KEY.test(key)) {
    return "Use the other computer's public key: 64 characters, only 0-9 and a-f.";
  }

  return key === own
    ? "That is this computer's own key. Enter the key the other computer shows."
    : undefined;
}
