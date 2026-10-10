import { ManagedRuntime } from "effect";
import type { Effect, Exit, Layer } from "effect";

/**
 * Runs tool programs on a lazily built runtime that session shutdown disposes.
 *
 * @template R - Services the tool programs need.
 */
export type ToolRuntime<R> = {
  /**
   * Run a program to its Exit. Aborting `signal` interrupts the program, so the Exit carries an
   * interruption the caller can report as a cancellation.
   */
  readonly runExit: <A, E>(
    program: Effect.Effect<A, E, R>,
    signal?: AbortSignal,
  ) => Promise<Exit.Exit<A, E>>;
  /** Dispose the current runtime, if any, interrupting running programs. Safe to repeat. */
  readonly dispose: () => Promise<void>;
};

/**
 * Create the tool boundary over one layer.
 *
 * The runtime is built on the first tool run rather than when the extension loads, because Pi
 * loads extensions in invocations that never start a session. Pi's docs (extensions.md) say
 * cancellation, reload, session replacement and process exit all reach `session_shutdown`, and a
 * reload replaces the extension runtime; a tool call that still arrives after shutdown rebuilds
 * the runtime instead of running on a disposed one.
 *
 * @template R - Services the layer provides.
 * @param layer - Services the tool programs run against.
 * @returns A runtime holder built lazily and disposed on demand.
 */
export function createToolRuntime<R>(layer: Layer.Layer<R>): ToolRuntime<R> {
  let runtime: ManagedRuntime.ManagedRuntime<R, never> | undefined;
  return {
    runExit: async (program, signal) => {
      runtime ??= ManagedRuntime.make(layer);
      return runtime.runPromiseExit(program, signal === undefined ? undefined : { signal });
    },
    dispose: async () => {
      // Clear the holder before awaiting so a repeated dispose is a no-op and a later run rebuilds.
      const current = runtime;
      runtime = undefined;
      await current?.dispose();
    },
  };
}
