// Test-only Pi extension for packages/pi-comms/test/bombadil/setup-apply.bombadil.ts. Not shipped.
//
// Like setup-extension.ts, but acquisition copies the locally built debug gateway (path in
// BOMBADIL_COMMS_GATEWAY, set by setup-apply.fixture.ts) into the throwaway home, so Apply really
// writes configuration and starts a gateway there. A second footer status shows disk and runtime
// state for the specification, kept under 80 columns together with the probe:
//   state:cfg=<y|n> sock=<up|dn> claim=<none|conn|off|kept> out=<ok|WRITE:path> step=<step>
// cfg: session-communication.json exists; sock: its socket accepts a connection; claim: what the
// last /comms command told the user (connected, participation disabled) or "kept" once a command
// that chose Keep and reconnect has finished; out: a new path under the REAL user's ~/.pi comms locations; step:
// <n>.<command>.<flags>.<outcome> for the last command, where flags has "r" for the first setup
// after a reset disabled participation and "c" when configuration existed at its start, and
// outcome is "running", then the kind of its first dialog (intent, existing, pair, repair, reset,
// other), "warn" if a warning came first, or "none".
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { paths, setupHarness } from "./setup-extension.js";
import type { HarnessObserver } from "./setup-extension.js";

const STATUS = "bombadil-state";
const POLL_MS = 300;
const realHome = userInfo().homedir;
// Only the locations pi-comms would write for the real user; the rest of ~/.pi/agent belongs to
// other running Pi sessions (their session files would be false positives).
const outside = [join(realHome, ".pi", "comms"), join(realHome, ".pi", "agent", "comms")];
const outsideConfig = join(realHome, ".pi", "agent", "session-communication.json");

/** The first new path in the real user's comms locations since `baseline`, or undefined. */
function escapedPath(baseline: ReadonlySet<string>, hadConfig: boolean): string | undefined {
  if (!hadConfig && existsSync(outsideConfig)) {
    return ".pi/agent/session-communication.json";
  }
  return [...paths(outside, realHome)].find((path) => !baseline.has(path));
}
const OUTCOMES: readonly (readonly [RegExp, string])[] = [
  [/^Collaboration setup/u, "intent"],
  [/^Setup-owned local participation/u, "existing"],
  [/^One peer:/u, "pair"],
  [/^Repair unavailable/u, "repair"],
  [/^Disable this agent/u, "reset"],
];

async function acquire(directory: string): Promise<string> {
  const gateway = process.env.BOMBADIL_COMMS_GATEWAY ?? "";
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const executable = join(directory, "pi-gateway");
  copyFileSync(gateway, executable);
  chmodSync(executable, 0o500);
  return executable;
}

function configuredSocket(adapter: string): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(adapter, "utf8"));
    return typeof value === "object" &&
      value !== null &&
      "socketPath" in value &&
      typeof value.socketPath === "string"
      ? value.socketPath
      : undefined;
  } catch {
    return undefined;
  }
}

async function reachable(path: string | undefined): Promise<boolean> {
  if (path === undefined) {
    return false;
  }
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const done = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(200, () => {
      done(false);
    });
    socket.once("error", () => {
      done(false);
    });
    socket.once("connect", () => {
      done(true);
    });
  });
}

function claimOf(message: string): string | undefined {
  if (
    message.startsWith("Configured and connected locally") ||
    message.startsWith("Saved configuration activated")
  ) {
    return "conn";
  }
  return message.startsWith("Participation disabled") ? "off" : undefined;
}

type Step = { n: number; command: string; flags: string; outcome: string };

/** Follows /comms commands through the harness observer: the last claim and the last step. */
function tracker(adapter: string, changed: () => void) {
  let claim = "none";
  let afterReset = false;
  let keep = false;
  let step: Step = { n: 0, command: "none", flags: "-", outcome: "none" };
  const settle = (outcome: string): void => {
    if (step.outcome === "running") {
      step = { ...step, outcome };
      changed();
    }
  };
  const command = (args: string): void => {
    const name = (args.trim() || "status").replaceAll(/\W/gu, "_").slice(0, 8);
    const flags = `${afterReset && name === "setup" ? "r" : ""}${existsSync(adapter) ? "c" : ""}`;
    afterReset &&= name !== "setup";
    step = { n: step.n + 1, command: name, flags: flags || "-", outcome: "running" };
    claim = "none";
    keep = false;
    changed();
  };
  const observer: HarnessObserver = {
    command,
    asked: (title) => {
      settle(OUTCOMES.find(([pattern]) => pattern.test(title))?.[1] ?? "other");
    },
    chose: (answer) => {
      keep ||= answer === "Keep and reconnect";
    },
    notified: (message, type) => {
      claim = claimOf(message) ?? claim;
      afterReset ||= claim === "off";
      if (type === "warning") {
        settle("warn");
      }
      changed();
    },
    finished: () => {
      claim = keep ? "kept" : claim;
      settle("none");
      changed();
    },
  };
  const line = (): string =>
    `claim=${claim} step=${step.n}.${step.command}.${step.flags}.${step.outcome}`;
  return { observer, line };
}

/** Every observer in `observers`, called in order. */
function combined(...observers: readonly HarnessObserver[]): HarnessObserver {
  return {
    command: (args) => {
      for (const observer of observers) {
        observer.command?.(args);
      }
    },
    asked: (title) => {
      for (const observer of observers) {
        observer.asked?.(title);
      }
    },
    chose: (answer) => {
      for (const observer of observers) {
        observer.chose?.(answer);
      }
    },
    notified: (message, type) => {
      for (const observer of observers) {
        observer.notified?.(message, type);
      }
    },
    finished: () => {
      for (const observer of observers) {
        observer.finished?.();
      }
    },
  };
}

/** The harness; `extra` observes after the state line's tracker (used by mutation checks). */
export function setupApplyHarness(pi: ExtensionAPI, extra: HarnessObserver = {}): void {
  const baseline = paths(outside, realHome);
  const hadConfig = existsSync(outsideConfig);
  const adapter = join(getAgentDir(), "session-communication.json");
  let escaped: string | undefined;
  let publish: (() => Promise<void>) | undefined;
  const tracked = tracker(adapter, () => void publish?.());
  const state = async (): Promise<string> => {
    escaped ??= escapedPath(baseline, hadConfig);
    const cfg = existsSync(adapter) ? "y" : "n";
    const sock = (await reachable(configuredSocket(adapter))) ? "up" : "dn";
    const out = escaped === undefined ? "ok" : `WRITE:${escaped}`;
    return `state:cfg=${cfg} sock=${sock} ${tracked.line().replace(" step=", ` out=${out} step=`)}`;
  };
  pi.on("session_start", async (_event, ctx) => {
    publish = async () => {
      ctx.ui.setStatus(STATUS, await state());
    };
    await publish();
    const timer = setInterval(() => void publish?.(), POLL_MS);
    timer.unref();
  });
  setupHarness(
    pi,
    {
      description: "Bombadil test backend: installs the local debug gateway into the test home.",
      backend: { acquire },
    },
    combined(tracked.observer, extra),
  );
}

export default function bombadilSetupApplyHarness(pi: ExtensionAPI): void {
  setupApplyHarness(pi);
}
