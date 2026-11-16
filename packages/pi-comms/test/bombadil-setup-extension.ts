// Test-only Pi extension for packages/pi-comms/test/setup.bombadil.ts. Not shipped.
//
// It loads pi-comms through its test backend seam with a backend that refuses every acquisition,
// so Apply can be fuzzed without building, downloading or starting a gateway. It also turns disk
// state into screen state, because Bombadil sees only the terminal: while a /comms command runs it
// polls the agent and home directories and sets the footer status to `probe:UNREVIEWED-WRITE` if a
// path appears before the user chose an Apply option in that command.
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import registerCommunication from "../index.js";

const STATUS = "bombadil-probe";
const POLL_MS = 50;

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

/** A property of `target`, with methods bound to it so they keep their receiver behind a proxy. */
function forwarded(target: object, property: string | symbol): unknown {
  const value: unknown = Reflect.get(target, property, target);
  if (typeof value !== "function") {
    return value;
  }
  const bound: unknown = value.bind(target);
  return bound;
}

/** The command context, with `ui.select` reporting when the user picks an Apply option. */
function withApplyTracking(
  ctx: ExtensionCommandContext,
  applied: () => void,
): ExtensionCommandContext {
  const select: ExtensionCommandContext["ui"]["select"] = async (...args) => {
    const answer = await ctx.ui.select(...args);
    if (typeof answer === "string" && answer.startsWith("Apply")) {
      applied();
    }
    return answer;
  };
  const ui = new Proxy(ctx.ui, {
    get: (target, property) => (property === "select" ? select : forwarded(target, property)),
  });
  return new Proxy(ctx, {
    get: (target, property) => (property === "ui" ? ui : forwarded(target, property)),
  });
}

export default function bombadilSetupHarness(pi: ExtensionAPI): void {
  const home = process.env.HOME ?? "";
  const roots = [getAgentDir(), home];
  let status: ((text: string) => void) | undefined;
  let violation: string | undefined;

  const report = (): void => {
    status?.(violation === undefined ? "probe:ok" : `probe:UNREVIEWED-WRITE ${violation}`);
  };

  /** Runs one command, flagging any new path that appears before an Apply was chosen. */
  const watched = async (run: (applied: () => void) => Promise<void>): Promise<void> => {
    const baseline = paths(roots, home);
    let applied = false;
    const check = (): void => {
      if (applied || violation !== undefined) {
        return;
      }
      const added = [...paths(roots, home)].find((path) => !baseline.has(path));
      if (added !== undefined) {
        violation = added;
        report();
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
  const host = new Proxy(pi, {
    get: (target, property) =>
      property === "registerCommand" ? register : forwarded(target, property),
  });

  pi.on("session_start", (_event, ctx) => {
    status = (text) => {
      ctx.ui.setStatus(STATUS, text);
    };
    report();
  });
  registerCommunication(host, {
    description: "Bombadil test backend: acquisition always refused; nothing is installed.",
    backend: {
      acquire: async () => {
        throw new Error("Bombadil test backend refuses acquisition");
      },
    },
  });
}
