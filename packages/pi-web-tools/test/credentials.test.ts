import { Cause, Effect, Exit, Logger, Redacted, Result } from "effect";
import { assert, describe, expect, test } from "vitest";
import { CredentialResolver, resolveCredentialSnapshot } from "../credentials";

const credentialEffect = Effect.gen(function* () {
  return yield* (yield* CredentialResolver).resolve("exa");
});

describe("credential boundary", () => {
  test("snapshots trim keys, deduplicate requests and leave unrequested providers absent", async () => {
    const calls: string[] = [];
    const snapshot = await Effect.runPromise(
      resolveCredentialSnapshot(["exa", "exa", "brave"]).pipe(
        Effect.provide(
          CredentialResolver.layerWith(async (name) => {
            calls.push(name);
            return { exa: " \n\t synthetic-key \n\t ", brave: undefined, parallel: undefined }[
              name
            ];
          }),
        ),
      ),
    );
    expect(calls).toStrictEqual(["exa", "brave"]);
    expect(snapshot.secrets).toStrictEqual(["synthetic-key"]);
    expect(snapshot.outcomes.parallel).toStrictEqual(Result.succeed(undefined));
    assert(Result.isSuccess(snapshot.outcomes.exa));
    assert(snapshot.outcomes.exa.success !== undefined);
    expect(Redacted.value(snapshot.outcomes.exa.success)).toBe("synthetic-key");
    expect(JSON.stringify(snapshot.outcomes)).not.toContain("synthetic-key");
  });

  test.each(["", "  ", "secret\nkey", "bad\u0000key", "bad\u007fkey"])(
    "rejects malformed credentials safely: %j",
    async (key) => {
      const result = await Effect.runPromise(
        Effect.result(credentialEffect).pipe(
          Effect.provide(CredentialResolver.layerWith(async () => key)),
        ),
      );
      assert(Result.isFailure(result));
      expect(result.failure.reason).toBe("invalid");
      expect(result.failure.message).toBe("credential invalid");
      expect(Object.keys(result.failure)).not.toContain("cause");
    },
  );

  test("missing is success; unavailable and rejected resolution remain safe failures", async () => {
    await expect(
      Effect.runPromise(
        credentialEffect.pipe(Effect.provide(CredentialResolver.layerWith(async () => undefined))),
      ),
    ).resolves.toBeUndefined();
    for (const layer of [
      CredentialResolver.unavailableLayer,
      CredentialResolver.layerWith(async () => {
        throw new Error("SECRET !private-command");
      }),
    ]) {
      const exit = await Effect.runPromiseExit(credentialEffect.pipe(Effect.provide(layer)));
      expect(JSON.stringify(exit)).not.toContain("SECRET");
      expect(JSON.stringify(exit)).not.toContain("private-command");
      assert(Exit.isFailure(exit));
    }
  });

  test("captured failure telemetry retains neither rejected values nor raw causes", async () => {
    const messages: string[] = [];
    const logger = Logger.make((options) => {
      messages.push(JSON.stringify(options.message));
    });
    const program = Effect.gen(function* () {
      const result = yield* Effect.result(credentialEffect);
      yield* Effect.logError(result);
    });
    await Effect.runPromise(
      program.pipe(
        Effect.provide(
          CredentialResolver.layerWith(async () => {
            throw new Error("private-synthetic-secret !private-command");
          }),
        ),
        Effect.provide(Logger.layer([logger])),
      ),
    );
    expect(messages.join(" ")).toContain("resolution");
    expect(messages.join(" ")).not.toContain("private-synthetic-secret");
    expect(messages.join(" ")).not.toContain("private-command");
  });

  test("deadline aborts the promise; interruption stays interruption", async () => {
    let signal: AbortSignal | undefined;
    const layer = CredentialResolver.layerWith(async (_, supplied) => {
      signal = supplied;
      return new Promise(() => {
        /* deliberately pending until interrupted */
      });
    }, "10 millis");
    const result = await Effect.runPromise(
      Effect.result(credentialEffect).pipe(Effect.provide(layer)),
    );
    assert(Result.isFailure(result));
    expect(result.failure.reason).toBe("timeout");
    expect(signal?.aborted).toBe(true);
    const controller = new AbortController();
    const running = Effect.runPromiseExit(
      credentialEffect.pipe(
        Effect.provide(
          CredentialResolver.layerWith(async (_, supplied) => {
            signal = supplied;
            return new Promise(() => {
              /* deliberately pending until interrupted */
            });
          }),
        ),
      ),
      { signal: controller.signal },
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    controller.abort();
    const exit = await running;
    assert(Exit.isFailure(exit));
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(signal?.aborted).toBe(true);
  });
});
