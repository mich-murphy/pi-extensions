import { Exit, ManagedRuntime } from "effect";
import type { Effect, Layer } from "effect";

/** Lazily built shared services, with explicit session activation and idempotent shutdown. */
export type ToolRuntime<R> = {
  /** Run on the current session; an aborted or closed session returns an interrupted Exit. */
  readonly runExit: <A, E>(
    program: Effect.Effect<A, E, R>,
    signal?: AbortSignal,
  ) => Promise<Exit.Exit<A, E>>;
  /** Activate for a session_start; subsequent work waits for any old disposal to finish. */
  readonly start: () => void;
  /** Close the session and interrupt its work. Repeated/concurrent shutdown is safe. */
  readonly dispose: () => Promise<void>;
};

/**
 * Resources are built only on first use. Shutdown closes the admission gate before disposing,
 * so late calls cannot resurrect clients. A new session_start explicitly reopens that gate;
 * reload creates a new holder. Never build a replacement while the old holder is disposing.
 */
export function createToolRuntime<R>(layer: Layer.Layer<R>): ToolRuntime<R> {
  let runtime: ManagedRuntime.ManagedRuntime<R, never> | undefined;
  let active = true;
  let session = new AbortController();
  let disposing: Promise<void> | undefined;
  return {
    runExit: async (program, signal) => {
      const operationSignal =
        signal === undefined ? session.signal : AbortSignal.any([session.signal, signal]);
      await disposing;
      if (!active || operationSignal.aborted) {
        return Exit.interrupt();
      }
      runtime ??= ManagedRuntime.make(layer);
      return runtime.runPromiseExit(program, { signal: operationSignal });
    },
    start: () => {
      if (!active) {
        session = new AbortController();
      }
      active = true;
    },
    dispose: async () => {
      active = false;
      session.abort();
      const current = runtime;
      runtime = undefined;
      disposing ??= current?.dispose() ?? Promise.resolve();
      const pending = disposing;
      try {
        await pending;
      } finally {
        if (disposing === pending) {
          disposing = undefined;
        }
      }
    },
  };
}
