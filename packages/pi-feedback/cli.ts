import process from "node:process";
import { agentDir } from "./agent-dir.ts";
import { runCli } from "./commands.ts";
import { ledgerPath } from "./ledger.ts";

process.exitCode = await runCli(process.argv.slice(2), {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
  ledger: ledgerPath(agentDir(process.env)),
});
