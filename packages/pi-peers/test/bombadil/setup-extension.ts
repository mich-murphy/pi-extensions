// Test-only Pi extension for packages/pi-peers/test/bombadil/setup.bombadil.ts. Not shipped.
//
// It loads pi-peers through its test backend seam with a backend that refuses every acquisition,
// so Apply can be fuzzed without building, downloading or starting a gateway. It also turns disk
// state into screen state, because Bombadil sees only the terminal: while a /peers command runs it
// polls the agent and home directories and, until the user chose an Apply option in that command,
// sets the footer status to `probe:UNREVIEWED-WRITE <path>` for a new path or
// `probe:UNREVIEWED-CHANGE <path>` for a changed or deleted one. Directories are compared by
// presence, small files by mode and SHA256, larger ones by mode, size and mtime. Sockets and the
// gateway's startup-*.log output are runtime state and are not compared.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import registerCommunication from "../../index.js";
import type { SetupBackend } from "../../onboarding/backend.js";

const STATUS = "bombadil-probe";
const POLL_MS = 50;
const SMALL = 65_536;
const LOG = /(?:^|\/)startup-[0-9a-f]+\.log$/u;
// Choices that consent to effects: every Apply, and "Keep and reconnect", which may start the
// gateway again (a startup log and a socket) without an Apply.
const CONSENT = /^(?:Apply|Keep and reconnect)/u;

/** Every path under `roots`, relative to `base`. */
function paths(roots: readonly string[], base: string): Set<string> {
  const found = new Set<string>();
  for (const root of roots) {
    try {
      for (const entry of readdirSync(root, { recursive: true })) {
        found.add(relative(base, join(root, String(entry))));
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

/** Every compared path under `roots`, relative to `base`, with its fingerprint. */
function snapshot(roots: readonly string[], base: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const path of paths(roots, base)) {
    const print = fingerprint(join(base, path));
    if (print !== undefined) {
      found.set(path, print);
    }
  }
  return found;
}

/** The first path added (`WRITE`), or changed or deleted (`CHANGE`), since `before`. */
function unreviewed(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string | undefined {
  const added = [...after.keys()].find((path) => !before.has(path));
  if (added !== undefined) {
    return `WRITE ${added}`;
  }
  const changed = [...before].find(([path, print]) => after.get(path) !== print)?.[0];
  return changed === undefined ? undefined : `CHANGE ${changed}`;
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

/** The command context, recording when the user picks a consenting option. */
function withApplyTracking(
  ctx: ExtensionCommandContext,
  applied: () => void,
): ExtensionCommandContext {
  const select: ExtensionCommandContext["ui"]["select"] = async (title, ...rest) => {
    const answer = await ctx.ui.select(title, ...rest);
    if (typeof answer === "string" && CONSENT.test(answer)) {
      applied();
    }
    return answer;
  };
  return overriding(ctx, { ui: overriding(ctx.ui, { select }) });
}

/** Runs commands, reporting the first unreviewed write or change before an Apply was chosen. */
function unreviewedProbe(roots: readonly string[], base: string, report: (found: string) => void) {
  let violation: string | undefined;
  return async (run: (applied: () => void) => Promise<void>): Promise<void> => {
    const baseline = snapshot(roots, base);
    let applied = false;
    const check = (): void => {
      if (applied || violation !== undefined) {
        return;
      }
      violation = unreviewed(baseline, snapshot(roots, base));
      if (violation !== undefined) {
        report(violation);
      }
    };
    const timer = setInterval(check, POLL_MS);
    try {
      await run(() => {
        check();
        applied = true;
      });
    } finally {
      clearInterval(timer);
      check();
    }
  };
}

const testBackend: { backend: SetupBackend; description: string } = {
  description: "Bombadil test backend: acquisition always refused; nothing is installed.",
  backend: {
    acquire: async () => {
      throw new Error("Bombadil test backend refuses acquisition");
    },
  },
};

/** Loads pi-peers with the refusing backend, flagging unreviewed writes and changes in the footer. */
export default function bombadilSetupHarness(pi: ExtensionAPI): void {
  let status: ((text: string) => void) | undefined;
  let shown = "probe:ok";
  const watched = unreviewedProbe(
    [getAgentDir(), process.env.HOME ?? ""],
    process.env.HOME ?? "",
    (found) => {
      shown = `probe:UNREVIEWED-${found}`;
      status?.(shown);
    },
  );

  const register: ExtensionAPI["registerCommand"] = (name, options) => {
    pi.registerCommand(name, {
      ...options,
      handler: async (args, ctx) => {
        await watched(async (applied) => {
          await options.handler(args, withApplyTracking(ctx, applied));
        });
      },
    });
  };

  pi.on("session_start", (_event, ctx) => {
    status = (text) => {
      ctx.ui.setStatus(STATUS, text);
    };
    status(shown);
  });
  registerCommunication(overriding(pi, { registerCommand: register }), testBackend);
}
