// Shared by the test-only extensions setup-extension.ts (refusing backend) and
// setup-success-extension.ts (copied debug gateway). Not shipped.
//
// Bombadil sees only the terminal, so this turns disk state into screen state. While a /peers
// command runs it polls the agent and home directories and, unless the user consented in the menu,
// sets the footer status to `probe:UNREVIEWED-WRITE <path>` for a new path or
// `probe:UNREVIEWED-CHANGE <path>` for a changed or deleted one. Directories are compared by
// presence, small files by mode and SHA256, larger ones by mode, size and mtime. Sockets are
// runtime state and are not compared; the gateway's startup-*.log files are compared by presence.
//
// Consent comes from the `testBackend.observe.consented(action)` seam, which the menu calls
// synchronously when a consent row is confirmed, before any effect. The probe has no seam for the
// end of an action, so it watches the action's outcome instead: every consented action ends in a
// `peers-report` transcript entry (`pi.appendEntry`), which this wrapper counts. From a consent
// until every consented action has reported and the tree has then been quiet for QUIET_MS (or
// SETTLE_MS has passed, for an action that never reports), the probe is settling:
//   - only the paths an action may legitimately touch are accepted (SCOPE: the pi-peers config
//     `pi-peers.json*`, the pi-peers directory, `~/.pi` and its pi-peers socket root, startup logs);
//   - every other path is still compared against the baseline, with or without a command running;
//   - when settling ends, the tree becomes the new baseline.
// Every command takes a fresh baseline when it starts, settling or not, after a final check of the
// old one, so nothing a command writes is absorbed unchecked. The footer then reads
// `probe:ok consent:<action>#<n> reports:<m>`: the last consent, numbered from 1, and the number of
// `peers-report` entries. The specifications use both to tie properties to an action's outcome.
//
// Known gaps: a second, unconsented command writing inside SCOPE while an action settles is not
// flagged (the menu refuses a second action while one runs); production acquisition is replaced by
// the test backends and so is never probed.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerCommunication from "../../index.js";
import type { SetupBackend } from "../../onboarding/backend.js";

const STATUS = "bombadil-probe";
const POLL_MS = 50;
const QUIET_MS = 3000;
const SETTLE_MS = 120_000;
const SMALL = 65_536;
const LOG = /(?:^|\/)startup-[0-9a-f]+\.log$/u;

/** Every path under `roots`, absolute. */
function paths(roots: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const root of roots) {
    try {
      for (const entry of readdirSync(root, { recursive: true })) {
        found.add(join(root, String(entry)));
      }
    } catch {
      // An absent root has no paths.
    }
  }
  return found;
}

/** How `path` compares across snapshots, or undefined for runtime state and vanished paths. */
function fingerprint(path: string): string | undefined {
  try {
    const stat = lstatSync(path);
    if (stat.isSocket()) {
      return undefined;
    }
    if (stat.isDirectory() || LOG.test(path)) {
      return stat.isDirectory() ? "dir" : "log";
    }
    const mode = stat.mode.toString(8);
    if (!stat.isFile() || stat.size > SMALL) {
      return `${mode}:${stat.size}:${stat.mtimeMs}`;
    }
    return `${mode}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  } catch {
    return undefined;
  }
}

/** Every compared path under `roots` with its fingerprint. */
function snapshot(roots: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const path of paths(roots)) {
    const print = fingerprint(path);
    if (print !== undefined) {
      found.set(path, print);
    }
  }
  return found;
}

/** The first `checked` path added (`WRITE`), or changed or deleted (`CHANGE`), since `before`. */
function unreviewed(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  checked: (path: string) => boolean,
): { kind: "WRITE" | "CHANGE"; path: string } | undefined {
  const added = [...after.keys()].find((path) => checked(path) && !before.has(path));
  if (added !== undefined) {
    return { kind: "WRITE", path: added };
  }
  const changed = [...before].find(
    ([path, print]) => checked(path) && after.get(path) !== print,
  )?.[0];
  return changed === undefined ? undefined : { kind: "CHANGE", path: changed };
}

/** Whether `path` is `root` or lies under it. */
function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** The paths a consented action may touch while it settles (see the header). */
function settlingScope(agentDir: string, home: string): (path: string) => boolean {
  const config = join(agentDir, "pi-peers.json");
  const directory = join(agentDir, "pi-peers");
  const dotPi = join(home, ".pi");
  const sockets = join(dotPi, "pi-peers");
  return (path) =>
    path.startsWith(config) ||
    within(path, directory) ||
    path === dotPi ||
    within(path, sockets) ||
    LOG.test(path);
}

/** A property of `target`, with methods bound to it so they keep their receiver behind a proxy. */
function forwarded(target: object, property: string | symbol): unknown {
  const value: unknown = Reflect.get(target, property, target);
  if (typeof value !== "function") {
    return value;
  }
  const bound: unknown = value.bind(target);
  return bound;
}

/** `target` with the members in `own` replacing its own. */
function overriding<T extends object>(target: T, own: Record<PropertyKey, unknown>): T {
  return new Proxy(target, {
    get: (object, property) =>
      Object.hasOwn(own, property) ? own[property] : forwarded(object, property),
  });
}

type Settling = { print: string; quietSince: number; since: number };

/** The unreviewed-change probe; `show` receives the footer text whenever it changes. */
function createProbe(
  roots: readonly string[],
  scope: (path: string) => boolean,
  shown: (path: string) => string,
  show: (text: string) => void,
) {
  let violation: string | undefined;
  let consent: string | undefined;
  let consents = 0;
  let reports = 0;
  /** Consented actions that have not reported an outcome yet. */
  let pending = 0;
  let baseline = new Map<string, string>();
  let commands = 0;
  let settling: Settling | undefined;
  const text = (): string => {
    if (violation !== undefined) {
      return `probe:UNREVIEWED-${violation}`;
    }
    const last = consent === undefined ? "" : ` consent:${consent}#${consents}`;
    return `probe:ok${last} reports:${reports}`;
  };
  const outside = (path: string): boolean => !scope(path);
  /** Ends settling once every action reported and the tree was quiet, or at the cap. */
  const settle = (now: Map<string, string>, active: Settling): void => {
    const print = JSON.stringify([...now]);
    const time = Date.now();
    if (print !== active.print) {
      settling = { ...active, print, quietSince: time };
    } else if (
      (pending === 0 && time - active.quietSince >= QUIET_MS) ||
      time - active.since >= SETTLE_MS
    ) {
      settling = undefined;
      pending = 0;
      baseline = now;
    }
  };
  const poll = (): void => {
    if (violation !== undefined || (settling === undefined && commands === 0)) {
      return;
    }
    const now = snapshot(roots);
    const active = settling;
    const found = unreviewed(baseline, now, active === undefined ? () => true : outside);
    if (found !== undefined) {
      violation = `${found.kind} ${shown(found.path)}`;
      show(text());
      return;
    }
    if (active !== undefined) {
      settle(now, active);
    }
  };
  setInterval(poll, POLL_MS).unref();
  return {
    text,
    consented: (action: string): void => {
      poll();
      consent = action;
      consents++;
      pending++;
      const time = Date.now();
      settling =
        settling === undefined
          ? { print: "", quietSince: time, since: time }
          : { ...settling, since: time };
      show(text());
    },
    reported: (): void => {
      reports++;
      pending = Math.max(0, pending - 1);
      if (settling !== undefined) {
        settling = { ...settling, quietSince: Date.now() };
      }
      show(text());
    },
    during: async (run: () => Promise<void>): Promise<void> => {
      poll();
      if (violation === undefined) {
        baseline = snapshot(roots);
      }
      commands++;
      try {
        await run();
      } finally {
        poll();
        commands--;
      }
    },
  };
}

/** Loads pi-peers with `backend`, flagging unreviewed writes and changes in the footer. */
export function probedPeers(pi: ExtensionAPI, backend: SetupBackend, description: string): void {
  let status: ((text: string) => void) | undefined;
  const home = process.env.HOME ?? "";
  const agentDir = getAgentDir();
  const probe = createProbe(
    [agentDir, home],
    settlingScope(agentDir, home),
    (path) => relative(home, path),
    (text) => status?.(text),
  );
  const registerCommand: ExtensionAPI["registerCommand"] = (name, options) => {
    pi.registerCommand(name, {
      ...options,
      handler: async (args, ctx) => {
        await probe.during(async () => {
          await options.handler(args, ctx);
        });
      },
    });
  };
  const appendEntry: ExtensionAPI["appendEntry"] = (customType, data) => {
    pi.appendEntry(customType, data);
    if (customType === "peers-report") {
      probe.reported();
    }
  };
  pi.on("session_start", (_event, ctx) => {
    status = (text) => {
      ctx.ui.setStatus(STATUS, text);
    };
    status(probe.text());
  });
  registerCommunication(overriding(pi, { registerCommand, appendEntry }), {
    backend,
    description,
    observe: { consented: probe.consented },
  });
}
