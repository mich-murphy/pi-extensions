import { ChildProcess } from "node:child_process";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test, vi } from "vitest";
import { caffeinateSpawner } from "../caffeinate-process";
import { CaffeinateNotice } from "../coffee-lifecycle";

const POLL_UNTIL_TRUE_WITH_LOADED_MACHINE_HANG_GUARD = { timeout: 20_000 };

const KILL_GRACE_MS = 50;

function systemError(code: string): Error {
  return Object.assign(new Error(code), { syscall: "kill", code });
}

function childSubscribedViaOnceExit(subscriptions: readonly unknown[]): ChildProcess {
  const child = subscriptions.at(-1);

  if (!(child instanceof ChildProcess)) {
    throw new TypeError("test setup: the adapter did not subscribe to a child process");
  }

  return child;
}

function summary(end: CaffeinateNotice): string {
  return CaffeinateNotice.$is("failed")(end)
    ? `${end.error.operation}:${end.error.code}`
    : end._tag;
}

describe("caffeinate child errors", () => {
  test("keeps reporting every error: a second one must not crash Pi as unhandled", async () => {
    const subscribe = vi.spyOn(ChildProcess.prototype, "once");
    const ends: CaffeinateNotice[] = [];

    const adapter = caffeinateSpawner(
      process.execPath,
      KILL_GRACE_MS,
    )(["-e", "setInterval(() => {}, 1000)"]);

    adapter.onNotice((end) => ends.push(end));
    const child = childSubscribedViaOnceExit(subscribe.mock.contexts);
    subscribe.mockRestore();

    child.emit("error", systemError("EPERM"));
    expect(() => child.emit("error", systemError("ESRCH"))).not.toThrow();
    adapter.stop();

    await vi.waitFor(() => {
      expect(ends.map((end) => summary(end))).toStrictEqual(["stop:EPERM", "stop:ESRCH", "exited"]);
    }, POLL_UNTIL_TRUE_WITH_LOADED_MACHINE_HANG_GUARD);
  });

  test("stop after exit signals nothing, so a reused PID is never hit", async () => {
    const subscribe = vi.spyOn(ChildProcess.prototype, "once");
    const adapter = caffeinateSpawner(process.execPath, KILL_GRACE_MS)(["-e", "process.exit(0)"]);

    const exited = new Promise((resolve) => {
      adapter.onNotice(resolve);
    });

    const child = childSubscribedViaOnceExit(subscribe.mock.contexts);
    subscribe.mockRestore();
    await exited;
    const kill = vi.spyOn(child, "kill");

    try {
      adapter.stop();
      await delay(KILL_GRACE_MS * 3);

      expect(kill.mock.calls).toStrictEqual([["SIGTERM"], ["SIGKILL"]]);
      expect(kill.mock.results).toStrictEqual([
        { type: "return", value: false },
        { type: "return", value: false },
      ]);
    } finally {
      kill.mockRestore();
    }
  });
});
