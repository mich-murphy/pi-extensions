import { Cause, Context, Effect, Exit, Layer } from "effect";
import { assert, describe, expect, test } from "vitest";
import { createToolRuntime } from "../tool-runtime";

class Counter extends Context.Service<Counter, { readonly build: number }>()("test/Counter") {}

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
  test("builds lazily, stays closed after dispose, and explicitly restarts", async () => {
    const { state, layer } = countingLayer();
    const runtime = createToolRuntime(layer);
    expect(state.builds).toBe(0);

    await expect(runtime.runExit(readBuild)).resolves.toStrictEqual(Exit.succeed(1));
    await expect(runtime.runExit(readBuild)).resolves.toStrictEqual(Exit.succeed(1));

    await runtime.dispose();
    await runtime.dispose();
    const late = await runtime.runExit(readBuild);
    assert(Exit.isFailure(late));
    expect(Cause.hasInterrupts(late.cause)).toBe(true);
    expect(state.builds).toBe(1);
    runtime.start();
    await expect(runtime.runExit(readBuild)).resolves.toStrictEqual(Exit.succeed(2));
    await runtime.dispose();
  });

  test("shutdown interrupts active work and does not cancel an unrelated new session", async () => {
    const runtime = createToolRuntime(countingLayer().layer);
    const active = runtime.runExit(Effect.never);
    await runtime.runExit(readBuild);
    await Promise.all([runtime.dispose(), runtime.dispose()]);
    const interrupted = await active;
    assert(Exit.isFailure(interrupted));
    expect(Cause.hasInterrupts(interrupted.cause)).toBe(true);
    runtime.start();
    await expect(runtime.runExit(readBuild)).resolves.toStrictEqual(Exit.succeed(2));
    await runtime.dispose();
  });

  test("pre-aborted calls do not build services and sibling cancellation is independent", async () => {
    const { state, layer } = countingLayer();
    const runtime = createToolRuntime(layer);
    const controller = new AbortController();
    controller.abort();
    expect(Exit.isFailure(await runtime.runExit(readBuild, controller.signal))).toBe(true);
    expect(state.builds).toBe(0);
    const sibling = new AbortController();
    const waiting = runtime.runExit(Effect.never, sibling.signal);
    await expect(runtime.runExit(readBuild)).resolves.toStrictEqual(Exit.succeed(1));
    sibling.abort();
    expect(Exit.isFailure(await waiting)).toBe(true);
    await expect(runtime.runExit(readBuild)).resolves.toStrictEqual(Exit.succeed(1));
    await runtime.dispose();
  });

  test("reactivation waits for old finalizers before building replacement services", async () => {
    let disposalStarted = Promise.withResolvers<undefined>();
    let disposalGate = Promise.withResolvers<undefined>();
    let builds = 0;
    const layer = Layer.effect(
      Counter,
      Effect.acquireRelease(
        Effect.sync(() => {
          builds += 1;
          return Counter.of({ build: builds });
        }),
        () =>
          Effect.promise(async () => {
            disposalStarted.resolve(undefined);
            return disposalGate.promise;
          }),
      ),
    );
    const runtime = createToolRuntime(layer);
    await expect(runtime.runExit(readBuild)).resolves.toStrictEqual(Exit.succeed(1));
    const disposing = runtime.dispose();
    await disposalStarted.promise;
    const lateOldCall = runtime.runExit(readBuild);
    runtime.start();
    const replacement = runtime.runExit(readBuild);
    expect(builds).toBe(1);
    disposalGate.resolve(undefined);
    await disposing;
    expect(Exit.isFailure(await lateOldCall)).toBe(true);
    await expect(replacement).resolves.toStrictEqual(Exit.succeed(2));
    disposalStarted = Promise.withResolvers<undefined>();
    disposalGate = Promise.withResolvers<undefined>();
    const finalDisposal = runtime.dispose();
    await disposalStarted.promise;
    disposalGate.resolve(undefined);
    await finalDisposal;
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
