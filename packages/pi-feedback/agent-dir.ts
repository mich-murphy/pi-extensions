import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_DIR_VARIABLE = "PI_CODING_AGENT_DIR";

export function agentDir(
  env: Readonly<Record<string, string | undefined>>,
  home: string = homedir(),
): string {
  const configured = env[AGENT_DIR_VARIABLE];
  if (configured === undefined || configured === "") {
    return join(home, ".pi", "agent");
  }
  if (configured === "~") {
    return home;
  }
  if (configured.startsWith("~/")) {
    return join(home, configured.slice(2));
  }
  if (configured.startsWith("file://")) {
    return fileURLToPath(configured);
  }
  return configured;
}
