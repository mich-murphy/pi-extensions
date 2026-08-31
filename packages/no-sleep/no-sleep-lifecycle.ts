import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** A classified failure from the Node child-process adapter. */
export class CaffeinateProcessError extends Error {
  /** Stable error discriminator. */
  readonly _tag = "CaffeinateProcessError" as const;

  /** Process operation that failed. */
  readonly operation: "spawn" | "runtime" | "SIGTERM" | "SIGKILL";

  /** Unclassified error received from Node. */
  override readonly cause: unknown;

  /**
   * Create a classified caffeinate process failure.
   *
   * @param operation - Process operation that failed.
   * @param cause - Unclassified error received from Node.
   */
  constructor(operation: "spawn" | "runtime" | "SIGTERM" | "SIGKILL", cause: unknown) {
    super(`caffeinate process failed during ${operation}`);
    this.operation = operation;
    this.cause = cause;
  }
}

/** Result returned by caffeinate process adapters. */
export type CaffeinateProcessResult<T> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "err"; readonly error: CaffeinateProcessError };

/** Process operations required by the no-sleep runtime. */
export type CaffeinateProcess = {
  /** Return whether the child has exited. */
  hasExited(): boolean;
  /** Allow Pi to exit independently of the child-process handle. */
  unref(): void;
  /** Send a termination signal to the child. */
  kill(signal: "SIGTERM" | "SIGKILL"): CaffeinateProcessResult<boolean>;
  /** Subscribe once to a classified child-process error. */
  onError(listener: (error: CaffeinateProcessError) => void): void;
  /** Subscribe once to child exit and return a listener-removal function. */
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;
};

/** Runtime and process dependencies used by the no-sleep lifecycle. */
export type NoSleepDependencies = {
  /** Current operating-system platform. */
  readonly platform: NodeJS.Platform;
  /** PID that caffeinate watches for crash-safe cleanup. */
  readonly processId: number;
  /** Time allowed for each graceful or forced termination attempt. */
  readonly terminationTimeoutMs: number;
  /** Start caffeinate with the supplied command arguments. */
  spawnCaffeinate(args: ReadonlyArray<string>): CaffeinateProcessResult<CaffeinateProcess>;
};

class CaffeinateStopTimeout extends Error {
  readonly _tag = "CaffeinateStopTimeout" as const;

  constructor() {
    super("caffeinate did not exit after SIGKILL");
  }
}

type StopResult =
  | { readonly _tag: "ok"; readonly value: undefined }
  | {
      readonly _tag: "err";
      readonly error: CaffeinateProcessError | CaffeinateStopTimeout;
    };

const ok: StopResult = { _tag: "ok", value: undefined };

function notify(ctx: ExtensionContext, message: string, level: "warning" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function causeDetail(error: CaffeinateProcessError): string {
  return error.cause instanceof Error ? `: ${error.cause.message}` : "";
}

function waitForExit(child: CaffeinateProcess, timeoutMs: number): Promise<boolean> {
  if (child.hasExited()) return Promise.resolve(true);

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const removeExitListener = child.onExit(() => {
      if (timer !== undefined) clearTimeout(timer);
      resolve(true);
    });
    timer = setTimeout(() => {
      removeExitListener();
      resolve(child.hasExited());
    }, timeoutMs);
  });
}

async function stopProcess(child: CaffeinateProcess, timeoutMs: number): Promise<StopResult> {
  if (child.hasExited()) return ok;

  const terminate = child.kill("SIGTERM");
  if (terminate._tag === "err" && !child.hasExited()) return terminate;

  if (await waitForExit(child, timeoutMs)) return ok;

  const kill = child.kill("SIGKILL");
  if (kill._tag === "err" && !child.hasExited()) return kill;

  if (await waitForExit(child, timeoutMs)) return ok;
  return { _tag: "err", error: new CaffeinateStopTimeout() };
}

type AgentActivity =
  | { readonly _tag: "idle" }
  | { readonly _tag: "active"; readonly unexpectedRestart: "available" | "used" };
type ManagedCaffeinate =
  | { readonly _tag: "stopped" }
  | { readonly _tag: "running"; readonly child: CaffeinateProcess }
  | { readonly _tag: "stopping"; readonly child: CaffeinateProcess };

class NoSleepLifecycle {
  private activity: AgentActivity = { _tag: "idle" };
  private process: ManagedCaffeinate = { _tag: "stopped" };

  constructor(private readonly dependencies: NoSleepDependencies) {}

  agentStarted(ctx: ExtensionContext): void {
    this.activity = { _tag: "active", unexpectedRestart: "available" };
    this.start(ctx);
  }

  async agentSettled(ctx: ExtensionContext): Promise<void> {
    if (!ctx.isIdle()) return;
    await this.deactivate(ctx);
  }

  async sessionShutdown(ctx: ExtensionContext): Promise<void> {
    await this.deactivate(ctx);
  }

  private start(ctx: ExtensionContext): void {
    if (this.dependencies.platform !== "darwin" || this.process._tag !== "stopped") return;
    const spawned = this.dependencies.spawnCaffeinate([
      "-d",
      "-i",
      "-s",
      "-w",
      String(this.dependencies.processId),
    ]);
    if (spawned._tag === "err") {
      notify(ctx, `No Sleep could not start caffeinate${causeDetail(spawned.error)}`, "error");
      return;
    }

    const child = spawned.value;
    this.process = { _tag: "running", child };
    child.unref();
    child.onError((error) => this.handleError(ctx, child, error));
    child.onExit((code, signal) => this.handleExit(ctx, child, code, signal));
  }

  private handleError(
    ctx: ExtensionContext,
    child: CaffeinateProcess,
    error: CaffeinateProcessError,
  ): void {
    if (this.process._tag !== "running" || this.process.child !== child) return;
    this.process = { _tag: "stopped" };
    notify(ctx, `No Sleep caffeinate failed${causeDetail(error)}`, "error");
  }

  private handleExit(
    ctx: ExtensionContext,
    child: CaffeinateProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.process._tag === "stopping" && this.process.child === child) {
      this.process = { _tag: "stopped" };
      if (this.activity._tag === "active") this.start(ctx);
      return;
    }
    if (this.process._tag !== "running" || this.process.child !== child) return;
    this.process = { _tag: "stopped" };
    if (this.activity._tag !== "active") return;

    const outcome = signal === null ? `exit code ${code ?? "unknown"}` : `signal ${signal}`;
    notify(ctx, `No Sleep lost caffeinate unexpectedly (${outcome})`, "warning");
    if (this.activity.unexpectedRestart === "available") {
      this.activity = { _tag: "active", unexpectedRestart: "used" };
      this.start(ctx);
    }
  }

  private async deactivate(ctx: ExtensionContext): Promise<void> {
    this.activity = { _tag: "idle" };
    await this.stop(ctx);
  }

  private async stop(ctx: ExtensionContext): Promise<void> {
    if (this.process._tag !== "running") return;
    const child = this.process.child;
    this.process = { _tag: "stopping", child };
    const result = await stopProcess(child, this.dependencies.terminationTimeoutMs);
    if (result._tag === "ok") {
      if (this.process._tag === "stopping" && this.process.child === child) {
        this.process = { _tag: "stopped" };
      }
      return;
    }

    const detail = result.error instanceof CaffeinateProcessError ? causeDetail(result.error) : "";
    notify(ctx, `No Sleep ${result.error.message}${detail}`, "error");
  }
}

/**
 * Register the no-sleep lifecycle using an injected caffeinate process adapter.
 *
 * @param pi - Pi extension API used to subscribe to lifecycle events.
 * @param dependencies - Platform and process operations owned by this extension runtime.
 */
export function registerNoSleep(pi: ExtensionAPI, dependencies: NoSleepDependencies): void {
  const lifecycle = new NoSleepLifecycle(dependencies);
  pi.on("agent_start", (_event, ctx) => lifecycle.agentStarted(ctx));
  pi.on("agent_settled", async (_event, ctx) => lifecycle.agentSettled(ctx));
  pi.on("session_shutdown", async (_event, ctx) => lifecycle.sessionShutdown(ctx));
}
