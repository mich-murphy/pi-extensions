import { ChildProcess } from "node:child_process";
import process from "node:process";
import { describe, expect, test, vi } from "vitest";
import { caffeinateSpawner } from "../caffeinate-process";
import type { CaffeinateEnd } from "../no-sleep-lifecycle";

// Waits poll observable state and return as soon as it holds; the budget is only a hang guard.
const OBSERVE = { timeout: 20_000 };

function systemError(code: string): Error {
  return Object.assign(new Error(code), { syscall: "kill", code });
}

/** The ChildProcess the adapter subscribed to, found through the `once("exit")` it registers. */
function subscribedChild(subscriptions: readonly unknown[]): ChildProcess {
  const child = subscriptions.at(-1);
  if (!(child instanceof ChildProcess)) {
    throw new TypeError("test setup: the adapter did not subscribe to a child process");
  }
  return child;
}

function summary(end: CaffeinateEnd): string {
  return end._tag === "failed" ? `${end.error.operation}:${end.error.code}` : end._tag;
}

describe("caffeinate child errors", () => {
  test("keeps reporting every error: a second one must not crash Pi as unhandled", async () => {
    const subscribe = vi.spyOn(ChildProcess.prototype, "once");
    const ends: CaffeinateEnd[] = [];
    const adapter = caffeinateSpawner(process.execPath, 50)(["-e", "setInterval(() => {}, 1000)"]);
    adapter.onEnd((end) => ends.push(end));
    const child = subscribedChild(subscribe.mock.contexts);
    subscribe.mockRestore();

    child.emit("error", systemError("EPERM"));
    expect(() => child.emit("error", systemError("ESRCH"))).not.toThrow();
    adapter.stop();

    await vi.waitFor(() => {
      expect(ends.map((end) => summary(end))).toStrictEqual(["stop:EPERM", "stop:ESRCH", "exited"]);
    }, OBSERVE);
  });
});
