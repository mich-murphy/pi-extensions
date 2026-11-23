import { setTimeout as timersPromisesDelay } from "node:timers/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fakeDelay } from "./fake-delay.js";

describe("fakeDelay", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  test("node:timers/promises ignores vitest fake timers, so tests inject fakeDelay", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const abort = new AbortController();
    let real = false;
    const pending = timersPromisesDelay(10_000, undefined, { signal: abort.signal }).then(
      () => {
        real = true;
        return undefined;
      },
      () => undefined,
    );
    let fake = false;
    const injected = fakeDelay(10_000).then(() => {
      fake = true;
      return undefined;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake).toBe(true);
    expect(real).toBe(false);
    abort.abort();
    await Promise.all([pending, injected]);
  });
  test("fakeDelay rejects when its signal aborts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const abort = new AbortController();
    const waiting = fakeDelay(10_000, abort.signal);
    abort.abort();
    await expect(waiting).rejects.toThrow("The operation was aborted");
  });
});
