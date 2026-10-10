import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Node could not start (spawn) or stop (signal) a caffeinate child. */
export class CaffeinateProcessError extends Error {
  /** Stable error discriminator. */
  readonly _tag = "CaffeinateProcessError" as const;

  /**
   * Create a classified caffeinate process failure.
   *
   * @param operation - Whether starting or stopping the child failed.
   * @param code - Node system error code, such as `ENOENT`.
   * @param cause - Original Node error, kept for local diagnosis only.
   */
  constructor(
    readonly operation: "start" | "stop",
    readonly code: string,
    override readonly cause: unknown,
  ) {
    super(
      operation === "start" && code === "ENOENT"
        ? "caffeinate is not available (is this macOS?)"
        : `Could not ${operation} caffeinate: ${code}`,
      { cause },
    );
    this.name = "CaffeinateProcessError";
  }
}

/** Why a caffeinate child stopped holding its sleep assertion. */
export type CaffeinateEnd =
  | {
      readonly _tag: "exited";
      /** Exit code, or null when the child was signalled. */
      readonly code: number | null;
      /** Terminating signal, or null when the child exited by itself. */
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly _tag: "failed"; readonly error: Readonly<CaffeinateProcessError> };

/** A spawned caffeinate child as the lifecycle sees it. */
export type CaffeinateProcess = {
  /**
   * Subscribe to the child's end. Spawn failures arrive here too, never synchronously.
   * A child can report more than once (a failed signal, then its exit).
   */
  readonly onEnd: (listener: (end: CaffeinateEnd) => void) => void;
  /** Terminate the child. Harmless once the child has ended. */
  readonly stop: () => void;
};

/** Runtime and process dependencies used by the no-sleep lifecycle. */
export type NoSleepDependencies = {
  /** Current operating-system platform. */
  readonly platform: NodeJS.Platform;
  /** PID that caffeinate watches, so a crashed Pi never leaves the Mac awake. */
  readonly processId: number;
  /** Start caffeinate with the supplied command arguments. */
  readonly spawnCaffeinate: (args: readonly string[]) => CaffeinateProcess;
};

/** Restart attempts after caffeinate exits unexpectedly, bounded so failures cannot loop. */
const UNEXPECTED_EXIT_RESTARTS = 1;

function notify(ctx: ExtensionContext, message: string, level: "warning" | "error"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  }
}

/**
 * Hold a macOS sleep assertion while Pi is doing agent work.
 *
 * @param pi - Pi extension API used to subscribe to lifecycle events.
 * @param dependencies - Platform and process operations owned by this extension runtime.
 */
export function registerNoSleep(pi: ExtensionAPI, dependencies: NoSleepDependencies): void {
  if (dependencies.platform !== "darwin") {
    return;
  }

  // The only state. A released child is forgotten at once: macOS counts sleep assertions per
  // process, so it may overlap its successor, and `-w` bounds its lifetime whatever happens.
  let held: CaffeinateProcess | undefined;

  const hold = (ctx: ExtensionContext, restartsLeft: number): void => {
    const child = dependencies.spawnCaffeinate([
      "-d",
      "-i",
      "-s",
      "-w",
      String(dependencies.processId),
    ]);
    held = child;
    child.onEnd((end) => {
      // Pi invalidates ctx only after session_shutdown, which releases the child, so ctx is
      // live past this guard.
      if (held !== child) {
        return;
      }
      held = undefined;
      if (end._tag === "failed") {
        notify(ctx, `No Sleep: ${end.error.message}`, "error");
        return;
      }
      const outcome = end.signal ? `signal ${end.signal}` : `exit code ${end.code ?? "unknown"}`;
      notify(ctx, `No Sleep lost caffeinate unexpectedly (${outcome})`, "warning");
      if (restartsLeft > 0) {
        hold(ctx, restartsLeft - 1);
      }
    });
  };

  const release = (): void => {
    // Forget before stopping, so whatever the child reports next is ignored, however soon.
    const child = held;
    held = undefined;
    child?.stop();
  };

  pi.on("agent_start", (_event, ctx) => {
    if (held === undefined) {
      hold(ctx, UNEXPECTED_EXIT_RESTARTS);
    }
  });
  pi.on("agent_settled", (_event, ctx) => {
    // Another extension may already have started the next run.
    if (ctx.isIdle()) {
      release();
    }
  });
  pi.on("session_shutdown", release);
}
