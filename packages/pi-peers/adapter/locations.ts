import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { errnoCode } from "../../shared/errno.js";

const NAMES = {
  current: { config: "pi-peers.json", directory: "pi-peers", socketRoot: "pi-peers" },
  legacy: { config: "session-communication.json", directory: "comms", socketRoot: "comms" },
} as const;

export type StateSetKind = keyof typeof NAMES;

export type StateSet = {
  readonly kind: StateSetKind;
  readonly config: string;
  readonly directory: string;
  readonly socketRoot: string;
  readonly id: string;
};

function present(path: string): boolean {
  try {
    lstatSync(path);

    return true;
  } catch (error) {
    const code = errnoCode(error);

    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

function realpathOrUnresolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function exists(set: StateSet): boolean {
  return present(set.config) || present(set.directory);
}

export function stateLocations(agentDir: string) {
  const agent = resolve(agentDir);
  const canonical = realpathOrUnresolved(agent);

  const locate = (kind: StateSetKind): StateSet => {
    const names = NAMES[kind];
    const directory = join(canonical, names.directory);

    return {
      kind,
      config: join(agent, names.config),
      directory,
      socketRoot: names.socketRoot,
      id: createHash("sha256").update(directory).digest("hex").slice(0, 16),
    };
  };

  const current = locate("current");
  const legacy = locate("legacy");
  const currentExists = exists(current);
  const legacyExists = exists(legacy);

  return {
    active: !currentExists && legacyExists ? legacy : current,
    ignored: currentExists && legacyExists ? legacy : undefined,
  };
}
