import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { onOffCommand } from "../shared/on-off-command";
import type { OnOffCommand } from "../shared/on-off-command";

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
        ? "caffeinate is not available at /usr/bin/caffeinate. Check the macOS installation; Pi can continue, but sleep prevention is unavailable."
        : `Could not ${operation} caffeinate (${["EAGAIN", "EACCES", "EPERM", "E2BIG", "ESRCH", "ENOMEM", "EMFILE", "ENFILE"].includes(code) ? code : "system error"}). Check macOS process permissions and resources; Pi can continue, but sleep prevention may be unavailable.`,
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

/** Runtime and process dependencies used by the coffee lifecycle. */
export type CoffeeDependencies = {
  /** Current operating-system platform. */
  readonly platform: NodeJS.Platform;
  /** PID that caffeinate watches, so a crashed Pi never leaves the Mac awake. */
  readonly processId: number;
  /** Start caffeinate with the supplied command arguments. */
  readonly spawnCaffeinate: (args: readonly string[]) => CaffeinateProcess;
};

/** Context capabilities consumed by sleep prevention and the `/coffee` command. */
export type CoffeeContext = Pick<ExtensionContext, "hasUI" | "isIdle"> & {
  readonly ui: Pick<ExtensionContext["ui"], "notify">;
};

/** Lifecycle callbacks consumed by sleep prevention. */
export type CoffeeHandlers = {
  [K in "agent_start" | "agent_settled" | "session_shutdown"]: (
    event: { readonly type: K },
    ctx: CoffeeContext,
  ) => void | Promise<void>;
};

/** Pi capabilities consumed by sleep prevention. */
export type CoffeeRegistration = {
  readonly registerCommand: (name: string, options: OnOffCommand<CoffeeContext>) => void;
  readonly on: {
    (name: "agent_start", handler: CoffeeHandlers["agent_start"]): unknown;
    (name: "agent_settled", handler: CoffeeHandlers["agent_settled"]): unknown;
    (name: "session_shutdown", handler: CoffeeHandlers["session_shutdown"]): unknown;
  };
};

const UNEXPECTED_EXIT_RESTARTS_PER_AGENT_START = 1;

function notify(ctx: CoffeeContext, message: string, level: "warning" | "error"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  }
}

/**
 * Register `/coffee [on|off]`, which turns sleep prevention on or off for the session.
 *
 * @param pi - Pi extension API used to register the command.
 * @param platform - Current operating-system platform, named in the confirmation off macOS.
 * @param setEnabled - Apply the new session state; called before the confirmation is shown.
 * @returns A reader for the current session state.
 */
function registerCoffeeCommand(
  pi: CoffeeRegistration,
  platform: NodeJS.Platform,
  setEnabled: (enabled: boolean, ctx: CoffeeContext) => void,
): () => boolean {
  let enabled = true;
  const unavailable =
    platform === "darwin" ? "" : " Sleep prevention is unavailable: it works on macOS only.";
  pi.registerCommand(
    "coffee",
    onOffCommand<CoffeeContext>({
      name: "coffee",
      label: "Coffee",
      description: "Turn sleep prevention while Pi works on or off for this session",
      enabled: () => enabled,
      apply: (next, ctx) => {
        enabled = next;
        setEnabled(enabled, ctx);
      },
      note: () => unavailable,
    }),
  );
  return () => enabled;
}

/**
 * Hold a macOS sleep assertion while Pi is doing agent work, unless `/coffee off` turned it off.
 *
 * @param pi - Pi extension API used to subscribe to lifecycle events and register `/coffee`.
 * @param dependencies - Platform and process operations owned by this extension runtime.
 */
export function registerCoffee(pi: CoffeeRegistration, dependencies: CoffeeDependencies): void {
  if (dependencies.platform !== "darwin") {
    registerCoffeeCommand(pi, dependencies.platform, () => undefined);
    return;
  }

  // A released child is forgotten at once: macOS counts sleep assertions per process, so it may
  // overlap its successor, and `-w` bounds its lifetime whatever happens.
  let held: CaffeinateProcess | undefined;

  const hold = (ctx: CoffeeContext, restartsLeft: number): void => {
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
        notify(ctx, `Coffee: ${end.error.message}`, "error");
        return;
      }
      const outcome = end.signal ? `signal ${end.signal}` : `exit code ${end.code ?? "unknown"}`;
      notify(
        ctx,
        `Coffee lost caffeinate unexpectedly (${outcome}). ${restartsLeft > 0 ? "Restarting sleep prevention once." : "Sleep prevention is unavailable until the next agent run; check macOS process permissions and resources."}`,
        "warning",
      );
      if (restartsLeft > 0) {
        hold(ctx, restartsLeft - 1);
      }
    });
  };

  const holdOnce = (ctx: CoffeeContext): void => {
    if (held === undefined) {
      hold(ctx, UNEXPECTED_EXIT_RESTARTS_PER_AGENT_START);
    }
  };

  const release = (): void => {
    const child = held;
    held = undefined;
    child?.stop();
  };

  const isEnabled = registerCoffeeCommand(pi, dependencies.platform, (enabled, ctx) => {
    if (!enabled) {
      release();
    } else if (!ctx.isIdle()) {
      holdOnce(ctx);
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    if (isEnabled()) {
      holdOnce(ctx);
    }
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.isIdle()) {
      release();
    }
  });
  pi.on("session_shutdown", release);
}
