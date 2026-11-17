import { Cause, Effect, Exit, ManagedRuntime } from "effect";
import type { Layer } from "effect";

/** A message for Pi's UI, in the shape `ctx.ui.notify` takes. */
export type CommandNotice = {
  /** Text to show the user. */
  readonly text: string;
  /** Notification level. */
  readonly level: "info" | "warning" | "error";
};

/**
 * Runs slash-command programs on a lazily built runtime that session shutdown disposes.
 *
 * @template R - Services the command programs need.
 */
export type CommandRunner<R> = {
  /**
   * Run a program and describe its outcome. Success is rendered by `render`, an expected failure
   * becomes an error notice with its safe message, a run that shutdown interrupts resolves to
   * undefined (there is no session left to report to), and defects reject unchanged.
   */
  readonly report: <A, E extends Error>(
    program: Effect.Effect<A, E, R>,
    render: (value: A) => CommandNotice,
  ) => Promise<CommandNotice | undefined>;
  /** Dispose the current runtime, if any, interrupting running commands. Safe to repeat. */
  readonly dispose: () => Promise<void>;
};

/**
 * Create the command boundary over one layer.
 *
 * The runtime is built on the first command rather than when the extension loads, because Pi
 * loads extensions in invocations that never start a session. Pi's docs say cancellation, reload,
 * session replacement and process exit all reach `session_shutdown`, and a reload replaces the
 * extension runtime; a command that still arrives after shutdown rebuilds the runtime instead of
 * running on a disposed one.
 *
 * @template R - Services the layer provides.
 * @param layer - Services the command programs run against.
 * @returns A runner whose runtime is built lazily and disposed on demand.
 */
export function createCommandRunner<R>(layer: Layer.Layer<R>): CommandRunner<R> {
  let runtime: ManagedRuntime.ManagedRuntime<R, never> | undefined;
  return {
    report: async (program, render) => {
      runtime ??= ManagedRuntime.make(layer);
      const exit = await runtime.runPromiseExit(
        program.pipe(
          Effect.match({
            onSuccess: render,
            onFailure: (error): CommandNotice => ({ text: error.message, level: "error" }),
          }),
        ),
      );
      if (Exit.isSuccess(exit)) {
        return exit.value;
      }
      if (Cause.hasInterruptsOnly(exit.cause)) {
        return undefined;
      }
      throw Cause.squash(exit.cause);
    },
    dispose: async () => {
      const current = runtime;
      runtime = undefined;
      await current?.dispose();
    },
  };
}
