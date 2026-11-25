import { Cause, Effect, Exit, ManagedRuntime } from "effect";
import type { Layer } from "effect";

export type CommandNotice = {
  readonly text: string;
  readonly level: "info" | "warning" | "error";
};

export type CommandRunner<R> = {
  readonly report: <A, E extends Error>(
    program: Effect.Effect<A, E, R>,
    render: (value: A) => CommandNotice,
  ) => Promise<CommandNotice | undefined>;
  readonly dispose: () => Promise<void>;
};

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
