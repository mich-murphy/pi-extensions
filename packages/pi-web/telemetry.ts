import { Cause, Effect, Exit, Option } from "effect";

/** Trace duration and safe failure summaries, never raw success values or defects.
 * The original exit is restored only after the span has ended. The operation remains interruptible.
 */
export function withSafeSpan<A, E, R>(
  name: string,
  operation: Effect.Effect<A, E, R>,
  summarizeFailure: (error: E) => unknown = () => "Operation failed",
): Effect.Effect<A, E, R> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      let original: Exit.Exit<A, E> | undefined;
      yield* Effect.exit(
        Effect.gen(function* () {
          const exit = yield* Effect.exit(restore(operation));
          original = exit;
          if (Exit.isFailure(exit)) {
            if (Cause.hasInterrupts(exit.cause)) {
              return yield* Effect.failCause(
                Cause.fromReasons(
                  exit.cause.reasons
                    .filter(Cause.isInterruptReason)
                    .map((reason) => Cause.makeInterruptReason(reason.fiberId)),
                ),
              );
            }
            const error = Cause.findErrorOption(exit.cause);
            return yield* Effect.fail(
              Option.isSome(error) ? summarizeFailure(error.value) : "Operation failed",
            );
          }
          return undefined;
        }).pipe(Effect.withSpan(name)),
      );
      // The span is closed before the real result (including interruption) leaves this boundary.
      if (original === undefined) {
        return yield* Effect.die(new Error("Traced operation did not produce an exit"));
      }
      return yield* original;
    }),
  );
}
