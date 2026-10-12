import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
   * Subscribe to process notifications. Spawn failures arrive here asynchronously. A `failed`
   * stop notification does not prove terminal exit, so the child may later report `exited`.
   */
  readonly onEnd: (listener: (end: CaffeinateEnd) => void) => void;
  /**
   * Request termination without waiting for it. A signalling failure may be reported through
   * `onEnd`; the process can continue and later emit its actual exit.
   */
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

/** Lifecycle callbacks consumed by sleep prevention. */
export type NoSleepHandlers = {
  [K in "agent_start" | "agent_settled" | "session_shutdown"]: (
    event: { readonly type: K },
    ctx: Pick<ExtensionContext, "hasUI" | "isIdle"> & {
      readonly ui: Pick<ExtensionContext["ui"], "notify">;
    },
  ) => void | Promise<void>;
};

/** Pi capabilities consumed by sleep prevention. */
export type NoSleepRegistration = {
  readonly on: {
    (name: "agent_start", handler: NoSleepHandlers["agent_start"]): unknown;
    (name: "agent_settled", handler: NoSleepHandlers["agent_settled"]): unknown;
    (name: "session_shutdown", handler: NoSleepHandlers["session_shutdown"]): unknown;
  };
};

type NoSleepContext = Pick<ExtensionContext, "hasUI" | "isIdle"> & {
  readonly ui: Pick<ExtensionContext["ui"], "notify">;
};

const UNEXPECTED_EXIT_RESTARTS_PER_AGENT_START = 1;

function notify(ctx: NoSleepContext, message: string, level: "warning" | "error"): void {
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
export function registerNoSleep(pi: NoSleepRegistration, dependencies: NoSleepDependencies): void {
  if (dependencies.platform !== "darwin") {
    return;
  }

  // The only state. A released child is forgotten at once: macOS counts sleep assertions per
  // process, so it may overlap its successor, and `-w` bounds its lifetime whatever happens.
  let held: CaffeinateProcess | undefined;

  const hold = (ctx: NoSleepContext, restartsLeft: number): void => {
    const child = dependencies.spawnCaffeinate([
      "-d",
      "-i",
      "-s",
      "-w",
      String(dependencies.processId),
    ]);
    held = child;
    child.onEnd((end) => {
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
    const child = held;
    held = undefined;
    child?.stop();
  };

  pi.on("agent_start", (_event, ctx) => {
    if (held === undefined) {
      hold(ctx, UNEXPECTED_EXIT_RESTARTS_PER_AGENT_START);
    }
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.isIdle()) {
      release();
    }
  });
  pi.on("session_shutdown", release);
}
