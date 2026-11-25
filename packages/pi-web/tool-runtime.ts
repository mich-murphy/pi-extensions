import { Exit, ManagedRuntime } from "effect";
import type { Effect, Layer } from "effect";

export type ToolRuntime<R> = {
  readonly runExit: <A, E>(
    program: Effect.Effect<A, E, R>,
    signal?: AbortSignal,
  ) => Promise<Exit.Exit<A, E>>;
  readonly start: () => void;
  readonly dispose: () => Promise<void>;
};

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
