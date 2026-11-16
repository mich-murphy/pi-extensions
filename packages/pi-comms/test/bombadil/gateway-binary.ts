// The locally built debug gateway that the Bombadil gateway specs run. Both launch fixtures call
// gatewayBinary(), and their npm scripts run this file first: a fixture error would only reach
// Bombadil's terminal as Pi exiting, so a missing or stale build must stop the run before it starts.
//
//   node --experimental-strip-types packages/pi-comms/test/bombadil/gateway-binary.ts
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const crate = fileURLToPath(new URL("../../gateway/", import.meta.url));
const binary = join(crate, "target/debug/pi-gateway");
const BUILD = "build it with `cargo build --locked` in packages/pi-comms/gateway";

/** The newest modification time of any file under `path`. */
function newestFile(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }
  return Math.max(0, ...readdirSync(path).map((name) => newestFile(join(path, name))));
}

/** The debug gateway's path; throws when it is missing or older than the gateway sources. */
export function gatewayBinary(): string {
  let built: number;
  try {
    built = statSync(binary).mtimeMs;
  } catch {
    throw new Error(`No debug gateway at ${binary}: ${BUILD}.`);
  }
  const sources = ["src", "Cargo.toml", "Cargo.lock"].map((name) => newestFile(join(crate, name)));
  if (Math.max(...sources) > built) {
    throw new Error(`The debug gateway is older than its sources: ${BUILD}.`);
  }
  return binary;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    gatewayBinary();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
