import { Context, Effect, Layer, Schema } from "effect";
import { describe, expect, test } from "vitest";
import { createCommandRunner } from "../command-runtime";
import type { CommandNotice } from "../command-runtime";

class Greeting extends Context.Service<Greeting, { readonly text: string }>()(
  "test/command-runtime/Greeting",
) {}

class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {}) {
  override get message(): string {
    return "the command failed";
  }
}

function countingLayer() {
  const builds = { count: 0 };
  const layer = Layer.effect(
    Greeting,
    Effect.sync(() => {
      builds.count += 1;
      return Greeting.of({ text: `hello ${builds.count}` });
    }),
  );
  return { builds, layer };
}

const greet = Effect.gen(function* () {
  return (yield* Greeting).text;
});

const asInfo = (text: string): CommandNotice => ({ text, level: "info" });

describe("command runtime", () => {
  test("builds the runtime on the first command and reuses it", async () => {
    const { builds, layer } = countingLayer();
    const runner = createCommandRunner(layer);

    expect(builds.count).toBe(0);
    await expect(runner.report(greet, asInfo)).resolves.toStrictEqual(asInfo("hello 1"));
    await expect(runner.report(greet, asInfo)).resolves.toStrictEqual(asInfo("hello 1"));
    expect(builds.count).toBe(1);
  });

  test("reports an expected failure as an error notice with its safe message", async () => {
    const runner = createCommandRunner(countingLayer().layer);

    await expect(runner.report(Effect.fail(new CommandFailed()), asInfo)).resolves.toStrictEqual({
      text: "the command failed",
      level: "error",
    });
  });

  test("rejects with a defect unchanged", async () => {
    const runner = createCommandRunner(countingLayer().layer);
    const defect = new Error("broken invariant");

    await expect(runner.report(Effect.die(defect), asInfo)).rejects.toBe(defect);
  });

  test("resolves a command that shutdown interrupts without reporting it", async () => {
    const runner = createCommandRunner(countingLayer().layer);

    const pending = runner.report(Effect.never, asInfo);
    await runner.dispose();

    await expect(pending).resolves.toBeUndefined();
  });

  test("rebuilds the runtime for a command after shutdown and disposes repeatedly", async () => {
    const { builds, layer } = countingLayer();
    const runner = createCommandRunner(layer);

    await runner.report(greet, asInfo);
    await runner.dispose();
    await runner.dispose();

    await expect(runner.report(greet, asInfo)).resolves.toStrictEqual(asInfo("hello 2"));
    expect(builds.count).toBe(2);
  });
});
