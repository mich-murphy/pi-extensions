import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Saved-state names. The legacy set predates the pi-peers rename; it is still used, as a whole,
 * when no current state exists, and it is never moved, rewritten or deleted by the extension.
 */
const NAMES = {
  current: { config: "pi-peers.json", directory: "pi-peers", socketRoot: "pi-peers" },
  legacy: { config: "session-communication.json", directory: "comms", socketRoot: "comms" },
} as const;
export type StateSetKind = keyof typeof NAMES;
export type StateSet = {
  readonly kind: StateSetKind;
  /** User-agent configuration file (not canonicalized, so configuration links stay visible). */
  readonly config: string;
  /** Setup-managed directory under the canonical agent directory. */
  readonly directory: string;
  /** Socket root segment under `<canonical home>/.pi`. */
  readonly socketRoot: string;
  /** Per-directory socket id: the first 16 hex digits of SHA256 of `directory`. */
  readonly id: string;
};

/** Absent means ENOENT or ENOTDIR. Any other error counts as present, so selection fails closed. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    );
  }
}

/**
 * The one place that decides which saved-state set is active. Current state wins whenever any of
 * it exists; the legacy set is used only when no current state exists and some legacy state does.
 * The two sets are never mixed: config, managed directory and socket root always come together.
 */
export function stateLocations(agentDir: string): {
  readonly active: StateSet;
  /** Legacy state present but ignored because current state exists. */
  readonly ignored: StateSet | undefined;
} {
  const agent = resolve(agentDir);
  let canonical = agent;
  try {
    canonical = realpathSync(agent);
  } catch {
    /* New profile is not created by inspection. */
  }
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
  const exists = (set: StateSet) => present(set.config) || present(set.directory);
  const currentExists = exists(current);
  const legacyExists = exists(legacy);
  return {
    active: !currentExists && legacyExists ? legacy : current,
    ignored: currentExists && legacyExists ? legacy : undefined,
  };
}
