import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { onOffCommand } from "../shared/on-off-command";
import type { OnOffCommand } from "../shared/on-off-command";

export class CaffeinateProcessError extends Error {
  readonly _tag = "CaffeinateProcessError" as const;

  constructor(
    readonly operation: "start" | "stop",
    readonly code: string,
    override readonly cause: unknown,
  ) {
    super(
      operation === "start" && code === "ENOENT"
        ? "/usr/bin/caffeinate was not found, so sleep prevention is unavailable."
        : `Could not ${operation} caffeinate (${["EAGAIN", "EACCES", "EPERM", "E2BIG", "ESRCH", "ENOMEM", "EMFILE", "ENFILE"].includes(code) ? code : "system error"}). ${operation === "start" ? "Sleep is allowed until the next agent run." : "It may keep the Mac awake until Pi exits."}`,
      { cause },
    );
    this.name = "CaffeinateProcessError";
  }
}

export type CaffeinateNotice =
  | {
      readonly _tag: "exited";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly _tag: "failed"; readonly error: Readonly<CaffeinateProcessError> };

export type CaffeinateProcess = {
  readonly onNotice: (listener: (notice: CaffeinateNotice) => void) => void;
  readonly stop: () => void;
};

export type CoffeeDependencies = {
  readonly platform: NodeJS.Platform;
  readonly processIdCaffeinateExitsWith: number;
  readonly spawnCaffeinate: (args: readonly string[]) => CaffeinateProcess;
};

export type CoffeeContext = Pick<ExtensionContext, "hasUI" | "isIdle"> & {
  readonly ui: Pick<ExtensionContext["ui"], "notify">;
};

export type CoffeeHandlers = {
  [K in "agent_start" | "agent_settled" | "session_shutdown"]: (
    event: { readonly type: K },
    ctx: CoffeeContext,
  ) => void | Promise<void>;
};

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

export function registerCoffee(pi: CoffeeRegistration, dependencies: CoffeeDependencies): void {
  if (dependencies.platform !== "darwin") {
    registerCoffeeCommand(pi, dependencies.platform, () => undefined);
    return;
  }

  let held: CaffeinateProcess | undefined;

  const hold = (ctx: CoffeeContext, restartsLeft: number): void => {
    const child = dependencies.spawnCaffeinate([
      "-i",
      "-s",
      "-w",
      String(dependencies.processIdCaffeinateExitsWith),
    ]);
    held = child;
    child.onNotice((notice) => {
      if (held !== child) {
        return;
      }
      held = undefined;
      if (notice._tag === "failed") {
        notify(ctx, `Coffee: ${notice.error.message}`, "error");
        return;
      }
      const outcome = notice.signal
        ? `signal ${notice.signal}`
        : `exit code ${notice.code ?? "unknown"}`;
      notify(
        ctx,
        restartsLeft > 0
          ? `Coffee: caffeinate stopped unexpectedly (${outcome}). Restarting it.`
          : `Coffee: caffeinate stopped again (${outcome}). Sleep is allowed until the next agent run.`,
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
