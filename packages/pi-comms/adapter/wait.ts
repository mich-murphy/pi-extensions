import { ConnectionFailure } from "./transport.js";

/** A caller's waiting budget never owns or cancels a shared session resource. */
export async function waitFor<A>(
  shared: Promise<A>,
  deadline: number,
  signal: AbortSignal,
): Promise<A> {
  if (signal.aborted) {
    throw new ConnectionFailure("cancelled", false);
  }
  if (deadline <= performance.now()) {
    throw new ConnectionFailure("unavailable", false);
  }
  return new Promise<A>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(new ConnectionFailure("unavailable", false));
    }, deadline - performance.now());
    const aborted = () => {
      finish(new ConnectionFailure("cancelled", false));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
    };
    function finish(error: unknown): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(
        error instanceof Error
          ? error
          : new Error("Shared initialization failed", { cause: error }),
      );
    }
    signal.addEventListener("abort", aborted, { once: true });
    void shared.then((value) => {
      if (settled) {
        return undefined;
      }
      settled = true;
      cleanup();
      resolve(value);
      return undefined;
    }, finish);
  });
}
