import { Cause, Context, Effect, Exit, Layer } from "effect";
import { assert, describe, expect, test } from "vitest";
import { createToolRuntime } from "../tool-runtime";

class Counter extends Context.Service<Counter, { readonly build: number }>()("test/Counter") {}

/** A layer that records how many times it has been built. */
function countingLayer() {
  const state = { builds: 0 };
  const layer = Layer.effect(
    Counter,
    Effect.sync(() => {
      state.builds += 1;
      return Counter.of({ build: state.builds });
    }),
  );
  return { state, layer };
}

const readBuild = Effect.gen(function* () {
  return (yield* Counter).build;
});

describe("createToolRuntime", () => {
  test("builds lazily, rebuilds after dispose, and disposes idempotently", async () => {
    const { state, layer } = countingLayer();
    const runtime = createToolRuntime(layer);
    expect(state.builds).toBe(0);

    await expect(runtime.runExit(readBuild)).resolves.toStrictEqual(Exit.succeed(1));
    await expect(runtime.runExit(readBuild)).resolves.toStrictEqual(Exit.succeed(1));

    await runtime.dispose();
    await runtime.dispose();
    await expect(runtime.runExit(readBuild)).resolves.toStrictEqual(Exit.succeed(2));
    await runtime.dispose();
  });

  test("aborting the signal interrupts the program", async () => {
    const runtime = createToolRuntime(countingLayer().layer);
    const controller = new AbortController();
    const outcome = runtime.runExit(Effect.never, controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 10);
    const exit = await outcome;
    assert(Exit.isFailure(exit));
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    await runtime.dispose();
  });
});
