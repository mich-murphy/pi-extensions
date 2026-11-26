import { ConnectionFailureError } from "./transport.js";

export async function waitFor<A>(
  shared: Promise<A>,
  deadline: number,
  signal: AbortSignal,
): Promise<A> {
  if (signal.aborted) {
    throw new ConnectionFailureError("cancelled", false);
  }

  if (deadline <= performance.now()) {
    throw new ConnectionFailureError("unavailable", false);
  }

  return new Promise<A>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      finish(new ConnectionFailureError("unavailable", false));
    }, deadline - performance.now());

    const aborted = () => {
      finish(new ConnectionFailureError("cancelled", false));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
    };

    function finish(error: Error): void {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    }

    async function settleShared(): Promise<void> {
      let value: A;

      try {
        value = await shared;
      } catch (error) {
        finish(
          error instanceof Error
            ? error
            : new Error("Shared initialization failed", { cause: error }),
        );

        return;
      }

      if (!settled) {
        settled = true;
        cleanup();
        resolve(value);
      }
    }

    signal.addEventListener("abort", aborted, { once: true });
    void settleShared();
  });
}
