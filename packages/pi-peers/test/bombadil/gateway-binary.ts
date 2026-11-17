// The locally built debug gateway that the Bombadil gateway specs run. Both launch fixtures call
// gatewayBinary(), and their npm scripts run this file first, which builds the gateway with cargo.
// Cargo rebuilds only what changed. File times cannot tell whether the binary is current: switching
// feature sets (as `cargo test --all-features` in `npm run check` does) restores a cached binary
// with its old modification time. A fixture error would only reach Bombadil's terminal as Pi
// exiting, so a failed build stops the run before it starts.
//
//   node --experimental-strip-types packages/pi-peers/test/bombadil/gateway-binary.ts
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const crate = fileURLToPath(new URL("../../gateway/", import.meta.url));
const binary = join(crate, "target/debug/pi-gateway");

/** The debug gateway's path; throws when it has not been built. */
export function gatewayBinary(): string {
  if (!existsSync(binary)) {
    throw new Error(
      `No debug gateway at ${binary}: build it with \`cargo build --locked\` in packages/pi-peers/gateway.`,
    );
  }
  return binary;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    execFileSync("cargo", ["build", "--locked", "--quiet"], { cwd: crate, stdio: "inherit" });
    gatewayBinary();
  } catch (error) {
    process.stderr.write(
      `Could not build the debug gateway in packages/pi-peers/gateway: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
