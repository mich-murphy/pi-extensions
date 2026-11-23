import type { Delay } from "../adapter/send.js";

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
