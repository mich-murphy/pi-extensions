import type { Delay } from "../adapter/send.js";

/**
 * Retry backoff for tests that use `vi.useFakeTimers()`. The default delay comes from
 * `node:timers/promises`, which fake timers do not control, so those tests waited on the real
 * 100 ms and 500 ms backoffs. This one reads the global `setTimeout` that fake timers replace.
 */
export const fakeDelay: Delay = async (milliseconds, signal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      globalThis.clearTimeout(timer);
      reject(new Error("The operation was aborted", { cause: signal?.reason }));
    };
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    if (signal?.aborted === true) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
