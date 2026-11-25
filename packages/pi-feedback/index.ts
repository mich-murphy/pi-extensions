import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import { registerFeedback } from "./feedback.ts";
import type { FeedbackRegistration } from "./feedback.ts";
import { ledgerPath } from "./ledger.ts";

const PACKAGES_DIR = fileURLToPath(new URL("..", import.meta.url));

export default function feedback(pi: FeedbackRegistration): void {
  const agentDir = getAgentDir();
  registerFeedback(pi, {
    ledger: ledgerPath(agentDir),
    agentDir,
    home: homedir(),
    packagesDir: PACKAGES_DIR,
    ownPackages: readdirSync(PACKAGES_DIR).filter((name) => name.startsWith("pi-")),
    piVersion: VERSION,
  });
}
