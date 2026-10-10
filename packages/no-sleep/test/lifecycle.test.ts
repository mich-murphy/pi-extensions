import { describe, expect, test } from "vitest";
import { CaffeinateProcessError, registerNoSleep } from "../no-sleep-lifecycle";
import type { CaffeinateEnd } from "../no-sleep-lifecycle";
import { fakePi } from "./fake-pi";

class FakeCaffeinate {
  stops = 0;
  private listener: ((end: CaffeinateEnd) => void) | undefined;

  onEnd(listener: (end: CaffeinateEnd) => void): void {
    this.listener = listener;
  }

  stop(): void {
    this.stops += 1;
    this.exit(null, "SIGTERM");
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.listener?.({ _tag: "exited", code, signal });
  }

  fail(operation: "start" | "stop", code: string): void {
    const cause = new Error(`${operation} ${code}`);
    this.listener?.({
      _tag: "failed",
      error: new CaffeinateProcessError(operation, code, cause),
    });
  }
}

function harness(platform: NodeJS.Platform = "darwin", hasUI = true) {
  const pi = fakePi(hasUI);
  const spawned: { args: readonly string[]; child: FakeCaffeinate }[] = [];
  registerNoSleep(pi.pi, {
    platform,
    processId: 9876,
    spawnCaffeinate: (args) => {
      const child = new FakeCaffeinate();
      spawned.push({ args, child });
      return child;
    },
  });
  return { ...pi, spawned };
}

describe("no-sleep lifecycle", () => {
  test("does nothing outside macOS", async () => {
    const pi = harness("linux");

    await pi.emit("agent_start");

    expect(pi.registeredEvents()).toStrictEqual([]);
    expect(pi.spawned).toHaveLength(0);
  });

  test("runs one caffeinate process until the agent settles", async () => {
    const pi = harness();

    await pi.emit("agent_start");
    await pi.emit("agent_start");
    expect(pi.spawned).toHaveLength(1);
    expect(pi.spawned[0]?.args).toStrictEqual(["-d", "-i", "-s", "-w", "9876"]);

    await pi.emit("agent_end");
    expect(pi.spawned[0]?.child.stops).toBe(0);

    await pi.emit("agent_settled");
    await pi.emit("agent_settled");
    expect(pi.spawned[0]?.child.stops).toBe(1);
    expect(pi.notifications).toStrictEqual([]);
  });

  test("keeps caffeinate when another run started before settlement", async () => {
    const pi = harness();

    await pi.emit("agent_start");
    pi.setIdle(false);
    await pi.emit("agent_settled");

    expect(pi.spawned[0]?.child.stops).toBe(0);
  });

  test("stops caffeinate on session shutdown", async () => {
    const pi = harness();

    await pi.emit("agent_start");
    await pi.emit("session_shutdown");

    expect(pi.spawned[0]?.child.stops).toBe(1);
  });

  test("starts a fresh caffeinate for the next run", async () => {
    const pi = harness();

    await pi.emit("agent_start");
    await pi.emit("agent_settled");
    await pi.emit("agent_start");

    expect(pi.spawned).toHaveLength(2);
    expect(pi.spawned[1]?.child.stops).toBe(0);
  });

  test("keeps separate Pi runtimes independent", async () => {
    const first = harness();
    const second = harness();

    await first.emit("agent_start");
    await second.emit("agent_start");
    await first.emit("agent_settled");

    expect(first.spawned[0]?.child.stops).toBe(1);
    expect(second.spawned[0]?.child.stops).toBe(0);
  });

  test("restarts once when caffeinate exits while the agent is active", async () => {
    const pi = harness();
    await pi.emit("agent_start");

    pi.spawned[0]?.child.exit(0, null);
    expect(pi.spawned).toHaveLength(2);
    pi.spawned[1]?.child.exit(null, "SIGKILL");

    expect(pi.spawned).toHaveLength(2);
    expect(pi.notifications).toStrictEqual([
      { message: "No Sleep lost caffeinate unexpectedly (exit code 0)", level: "warning" },
      { message: "No Sleep lost caffeinate unexpectedly (signal SIGKILL)", level: "warning" },
    ]);

    await pi.emit("agent_start");
    expect(pi.spawned).toHaveLength(3);
  });

  test("reports a caffeinate that cannot run without restarting it", async () => {
    const pi = harness();
    await pi.emit("agent_start");

    pi.spawned[0]?.child.fail("start", "ENOENT");
    pi.spawned[0]?.child.fail("stop", "EPERM");

    expect(pi.spawned).toHaveLength(1);
    expect(pi.notifications).toStrictEqual([
      { message: "No Sleep: caffeinate is not available (is this macOS?)", level: "error" },
    ]);
  });

  test("names the failed operation and its code", async () => {
    const pi = harness();
    await pi.emit("agent_start");
    pi.spawned[0]?.child.fail("start", "EAGAIN");
    await pi.emit("agent_start");
    pi.spawned[1]?.child.fail("stop", "EPERM");

    expect(pi.notifications).toStrictEqual([
      { message: "No Sleep: Could not start caffeinate: EAGAIN", level: "error" },
      { message: "No Sleep: Could not stop caffeinate: EPERM", level: "error" },
    ]);
  });

  test("ignores late events from a released child", async () => {
    const pi = harness();
    await pi.emit("agent_start");
    await pi.emit("agent_settled");
    await pi.emit("agent_start");

    pi.spawned[0]?.child.exit(null, "SIGKILL");
    pi.spawned[0]?.child.fail("stop", "EPERM");
    await pi.emit("agent_start");

    expect(pi.spawned).toHaveLength(2);
    expect(pi.spawned[1]?.child.stops).toBe(0);
    expect(pi.notifications).toStrictEqual([]);
  });

  test("stays silent without a UI", async () => {
    const pi = harness("darwin", false);
    await pi.emit("agent_start");

    pi.spawned[0]?.child.fail("start", "EACCES");

    expect(pi.notifications).toStrictEqual([]);
  });
});
