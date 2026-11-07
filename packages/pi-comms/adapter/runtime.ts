import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer, ManagedRuntime, Queue } from "effect";
import type { PeerRef } from "../protocol/schema.js";
import type { Configuration } from "./config.js";
import { AdapterSession } from "./session.js";
import type { AdapterHost } from "./session.js";

class AdapterService extends Context.Service<AdapterService, AdapterSession>()(
  "pi-comms/Adapter",
) {}
/** Exactly one scoped service, wake Queue and pump fiber per enabled session lifetime. */
export async function createAdapterRuntime(
  config: Configuration,
  peer: PeerRef,
  pi: Pick<ExtensionAPI, "sendMessage">,
  context: () => AdapterHost | undefined,
) {
  const layer = Layer.effect(
    AdapterService,
    Effect.gen(function* () {
      const queue = yield* Queue.make<undefined>({ capacity: 1, strategy: "dropping" });
      const session = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new AdapterSession(config, peer, pi, context, () => {
              Queue.offerUnsafe(queue, undefined);
            }),
        ),
        (current) =>
          Effect.sync(() => {
            current.close();
            Queue.shutdownUnsafe(queue);
          }),
      );
      yield* Effect.forever(
        Effect.flatMap(Queue.take(queue), () =>
          Effect.sync(() => {
            session.pumpIdle();
          }),
        ),
      ).pipe(Effect.forkScoped);
      yield* Effect.promise(async () => session.start()).pipe(Effect.forkScoped);
      return session;
    }),
  );
  const runtime = ManagedRuntime.make(layer);
  const session = await runtime.runPromise(AdapterService);
  return { session, dispose: async () => runtime.dispose() };
}
