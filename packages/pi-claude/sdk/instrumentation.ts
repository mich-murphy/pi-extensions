import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { z } from "zod";
import { MAX_CACHE_BREAKPOINTS } from "../agent-request";
import type { AgentRequest } from "../agent-request";
import { SdkInstrumentationError, SdkQueryError } from "./errors";

// This is an SDK-adapted data payload, not query() options. Control-plane wiring is never exposed.
const payloadSchema = z
  .strictObject({
    promptBlocks: z
      .array(
        z.strictObject({
          text: z.string().max(16_777_216),
          images: z
            .array(
              z.strictObject({
                data: z.string().max(16_777_216),
                mediaType: z.string().min(1).max(256),
              }),
            )
            .max(100),
        }),
      )
      .min(1)
      .max(4096),
    cacheBreakpoints: z.array(z.number().int().nonnegative()).max(MAX_CACHE_BREAKPOINTS),
  })
  .refine(({ promptBlocks, cacheBreakpoints }) =>
    cacheBreakpoints.every(
      (breakpoint, index) =>
        breakpoint < promptBlocks.length &&
        (index === 0 || breakpoint > (cacheBreakpoints[index - 1] ?? 0)),
    ),
  );

async function waitForCallback<A>(work: () => Promise<A>, signal: AbortSignal): Promise<A> {
  let abort: (() => void) | undefined;
  return new Promise<A>((resolve, reject) => {
    abort = (): void => {
      reject(new SdkInstrumentationError({ operation: "cancelled" }));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    } else {
      // Both resolutions are observed even after cancellation; late callback rejection cannot escape.
      void Promise.resolve()
        .then(async () => {
          signal.throwIfAborted();
          return work();
        })
        .then(resolve, reject);
    }
  }).finally(() => {
    if (abort) {
      signal.removeEventListener("abort", abort);
    }
  });
}

/** Await trusted callbacks without retaining their exceptions or blocking turn cancellation. */
function callback<A>(operation: "payload" | "event", signal: AbortSignal, work: () => Promise<A>) {
  return Effect.tryPromise({
    try: async (interruptSignal) => {
      const combined = AbortSignal.any([signal, interruptSignal]);
      return waitForCallback(work, combined);
    },
    catch: () =>
      signal.aborted
        ? SdkQueryError.cancelled(operation === "payload" ? "start" : "iterate", undefined)
        : new SdkInstrumentationError({ operation }),
  });
}

/** Apply only prompt data; SDK tools, environment, permissions, routing and cancellation stay owned. */
export function instrumentRequest(
  request: AgentRequest,
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
  signal: AbortSignal,
) {
  if (!options?.onPayload) {
    return Effect.succeed(request);
  }
  const onPayload = options.onPayload;
  const payload = {
    promptBlocks: request.promptBlocks.map(({ text, images }) => ({
      text,
      images: images.map((image) => ({ ...image })),
    })),
    cacheBreakpoints: [...request.cacheBreakpoints],
  };
  return callback("payload", signal, async () => onPayload(payload, model)).pipe(
    Effect.flatMap((replacement) =>
      Effect.try({
        try: () => {
          const data = payloadSchema.parse(replacement === undefined ? payload : replacement);
          return { ...request, ...data };
        },
        catch: () => new SdkInstrumentationError({ operation: "replacement" }),
      }),
    ),
  );
}

/** Observe every SDK-yielded parsed value before provider-specific validation/normalization. */
export function instrumentEvent(
  event: unknown,
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
  signal: AbortSignal,
) {
  if (!options?.onProviderStreamEvent) {
    return Effect.succeed(event);
  }
  const onEvent = options.onProviderStreamEvent;
  return callback("event", signal, async () => {
    await onEvent(event, model);
    return event;
  });
}
