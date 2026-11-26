import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { assert, describe, expect, test, vi } from "vitest";
import { caffeinateSpawner } from "../caffeinate-process";
import type { CaffeinateNotice } from "../coffee-lifecycle";

const POLL_UNTIL_TRUE_WITH_LOADED_MACHINE_HANG_GUARD = { timeout: 20_000 };

const KILL_GRACE_MS = 50;

function systemError(code: string): Error {
  return Object.assign(new Error(code), { syscall: "kill", code });
}

function summary(end: CaffeinateNotice): string {
  return end._tag === "failed" ? `${end.error.operation}:${end.error.code}` : end._tag;
}

describe("caffeinate child errors", () => {
  test("keeps reporting every error: a second one must not crash Pi as unhandled", async () => {
    const startChild = vi.fn<NonNullable<Parameters<typeof caffeinateSpawner>[2]>>(spawn);
    const ends: Array<CaffeinateNotice> = [];

    const adapter = caffeinateSpawner(
      process.execPath,
      KILL_GRACE_MS,
      startChild,
    )(["-e", "setInterval(() => {}, 1000)"]);

    adapter.onNotice((end) => ends.push(end));
    const child = startChild.mock.results[0];
    assert(child?.type === "return");

    child.value.emit("error", systemError("EPERM"));
    expect(() => child.value.emit("error", systemError("ESRCH"))).not.toThrow();
    adapter.stop();

    await vi.waitFor(() => {
      expect(ends.map((end) => summary(end))).toStrictEqual(["stop:EPERM", "stop:ESRCH", "exited"]);
    }, POLL_UNTIL_TRUE_WITH_LOADED_MACHINE_HANG_GUARD);
  });

  test("stop after exit signals nothing, so a reused PID is never hit", async () => {
    const startChild = vi.fn<NonNullable<Parameters<typeof caffeinateSpawner>[2]>>(spawn);

    const adapter = caffeinateSpawner(
      process.execPath,
      KILL_GRACE_MS,
      startChild,
    )(["-e", "process.exit(0)"]);

    const exited = new Promise((resolve) => {
      adapter.onNotice(resolve);
    });

    const child = startChild.mock.results[0];
    assert(child?.type === "return");
    await exited;
    const kill = vi.spyOn(child.value, "kill");

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
