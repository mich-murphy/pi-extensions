import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FakeClaudeBehaviour = {
  readonly version: string;
  readonly usage?: unknown;
  readonly turn?: readonly unknown[];
};

export type FakeClaude = {
  readonly path: string;
  readonly directory: string;
  readonly spawnedWith: () => readonly (readonly string[])[];
  readonly controlRequests: () => readonly unknown[];
};

const SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const behaviour = JSON.parse(fs.readFileSync(path.join(__dirname, "behaviour.json"), "utf8"));
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(behaviour.version + " (Claude Code)");
  process.exit(0);
}
fs.appendFileSync(path.join(__dirname, "spawned.jsonl"), JSON.stringify(args) + "\\n");
const respond = (requestId, response) =>
  console.log(JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  }));
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  const lines = buffered.split("\\n");
  buffered = lines.pop();
  for (const line of lines.filter(Boolean)) {
    const message = JSON.parse(line);
    fs.appendFileSync(path.join(__dirname, "stdin.jsonl"), line + "\\n");
    if (message.type === "user") {
      for (const reply of behaviour.turn ?? []) console.log(JSON.stringify(reply));
      continue;
    }
    if (message.type !== "control_request") continue;
    const subtype = message.request.subtype;
    if (subtype === "get_usage" && behaviour.usage === undefined) {
      console.log(JSON.stringify({
        type: "control_response",
        response: { subtype: "error", request_id: message.request_id, error: "usage unavailable" },
      }));
    } else {
      respond(
        message.request_id,
        subtype === "get_usage" ? behaviour.usage : subtype === "initialize" ? { hook_on_failure_supported: true } : {},
      );
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

export function installFakeClaude(behaviour: FakeClaudeBehaviour): FakeClaude {
  const directory = mkdtempSync(join(tmpdir(), "claude-fake-cli-"));
  const path = join(directory, "claude");
  writeFileSync(join(directory, "behaviour.json"), JSON.stringify(behaviour));
  writeFileSync(path, SCRIPT);
  chmodSync(path, 0o755);
  return {
    path,
    directory,
    controlRequests: () => {
      try {
        return readFileSync(join(directory, "stdin.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line): unknown => JSON.parse(line))
          .flatMap((message) =>
            typeof message === "object" && message !== null && "request" in message
              ? [message.request]
              : [],
          );
      } catch {
        return [];
      }
    },
    spawnedWith: () => {
      const log = join(directory, "spawned.jsonl");
      try {
        return readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line): readonly string[] => {
            const args: unknown = JSON.parse(line);
            return Array.isArray(args) ? args.map(String) : [];
          });
      } catch {
        return [];
      }
    },
  };
}
