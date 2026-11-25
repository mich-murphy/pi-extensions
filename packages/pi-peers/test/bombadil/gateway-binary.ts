import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const crate = fileURLToPath(new URL("../../gateway/", import.meta.url));
const binary = join(crate, "target/debug/pi-gateway");

function buildEvenWhenCargoRestoredAnOldBinary(): void {
  execFileSync("cargo", ["build", "--locked", "--quiet"], { cwd: crate, stdio: "inherit" });
}

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
    buildEvenWhenCargoRestoredAnOldBinary();
    gatewayBinary();
  } catch (error) {
    process.stderr.write(
      `Could not build the debug gateway in packages/pi-peers/gateway: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
