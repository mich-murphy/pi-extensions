import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { plainText } from "./config.js";
import type { Configuration } from "./config.js";
import { sessionHandle } from "./handles.js";

const LIMIT = 128;
const run = promisify(execFile);

export type LabelFacts = {
  readonly configured: string;
  readonly machineId: string;
  readonly cwd: string;
  readonly sessionName?: string | undefined;
  readonly parentSession?: string | undefined;
  readonly branch?: string | undefined;
};

export function parentSessionId(path: string): string | undefined {
  const name = basename(path).replace(/\.jsonl$/u, "");
  const index = name.lastIndexOf("_");

  return index < 0 || index === name.length - 1 ? undefined : name.slice(index + 1);
}

function fits(value: string): boolean {
  return Buffer.byteLength(value) <= LIMIT;
}

function truncated(value: string): string {
  let kept = "";

  for (const character of value) {
    if (!fits(`${kept}${character}…`)) {
      break;
    }

    kept += character;
  }

  return `${kept}…`;
}

export function composeLabel(facts: LabelFacts): string {
  const parent =
    facts.parentSession === undefined ? undefined : parentSessionId(facts.parentSession);

  const parts = [
    facts.configured,
    facts.sessionName ?? "",
    basename(facts.cwd),
    parent === undefined ? "" : `derived from ${sessionHandle(facts.machineId, parent)}`,
    facts.branch === undefined ? "" : `branch ${facts.branch} at connect`,
  ].flatMap((part) => {
    const text = plainText(part);

    return text.length > 0 ? [text] : [];
  });

  for (let count = parts.length; count > 0; count -= 1) {
    const label = parts.slice(0, count).join(" · ");

    if (fits(label)) {
      return label;
    }
  }

  return parts[0] === undefined ? "Pi" : truncated(parts[0]);
}

export async function readBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      timeout: 1000,
    });

    const branch = stdout.trim();

    return branch === "" || branch === "HEAD" ? undefined : branch;
  } catch {
    return undefined;
  }
}

export async function connectLabel(
  config: Configuration,
  sessions: Pick<ExtensionContext["sessionManager"], "getCwd" | "getSessionName" | "getHeader">,
): Promise<string> {
  const cwd = sessions.getCwd();

  return composeLabel({
    configured: config.label,
    machineId: config.machineId,
    cwd,
    sessionName: sessions.getSessionName(),
    parentSession: sessions.getHeader()?.parentSession,
    branch: config.shareBranch === true ? await readBranch(cwd) : undefined,
  });
}
