import { describe, expect, test } from "vitest";
import { CaffeinateProcessError, registerCoffee } from "../coffee-lifecycle";
import type { CaffeinateEnd } from "../coffee-lifecycle";
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
  registerCoffee(pi.pi, {
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

describe("coffee lifecycle", () => {
  test("registers only /coffee outside macOS and never spawns", async () => {
    const pi = harness("linux");

    await pi.emit("agent_start");
    pi.setIdle(false);
    await pi.command("on");
    await pi.command("");
    await pi.command("");

    expect(pi.registeredEvents()).toStrictEqual([]);
    expect(pi.registeredCommands()).toStrictEqual(["coffee"]);
    expect(pi.spawned).toHaveLength(0);
    const unavailable = " Sleep prevention is unavailable: it works on macOS only.";
    expect(pi.notifications).toStrictEqual([
      { message: `Coffee is on for this session.${unavailable}`, level: "info" },
      { message: `Coffee is off for this session.${unavailable}`, level: "info" },
      { message: `Coffee is on for this session.${unavailable}`, level: "info" },
    ]);
  });

  test("runs one caffeinate process until the agent settles", async () => {
    const pi = harness();

    await pi.emit("agent_start");
    await pi.emit("agent_start");
    expect(pi.spawned).toHaveLength(1);
    expect(pi.spawned[0]?.args).toStrictEqual(["-i", "-s", "-w", "9876"]);

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
      {
        message:
          "Coffee lost caffeinate unexpectedly (exit code 0). Restarting sleep prevention once.",
        level: "warning",
      },
      {
        message:
          "Coffee lost caffeinate unexpectedly (signal SIGKILL). Sleep prevention is unavailable until the next agent run; check macOS process permissions and resources.",
        level: "warning",
      },
    ]);

    await pi.emit("agent_start");
    expect(pi.spawned).toHaveLength(3);
  });

  test("a continuation without settlement gets a fresh restart allowance", async () => {
    const pi = harness();
    await pi.emit("agent_start");
    pi.setIdle(false);

    pi.spawned[0]?.child.exit(1, null);
    pi.spawned[1]?.child.exit(1, null);
    expect(pi.spawned).toHaveLength(2);

    await pi.emit("agent_start");
    expect(pi.spawned).toHaveLength(3);
    pi.spawned[2]?.child.exit(1, null);
    expect(pi.spawned).toHaveLength(4);
  });

  test("reports a caffeinate that cannot run without restarting it", async () => {
    const pi = harness();
    await pi.emit("agent_start");

    pi.spawned[0]?.child.fail("start", "ENOENT");
    pi.spawned[0]?.child.fail("stop", "EPERM");

    expect(pi.spawned).toHaveLength(1);
    expect(pi.notifications).toStrictEqual([
      {
        message:
          "Coffee: caffeinate is not available at /usr/bin/caffeinate. Check the macOS installation; Pi can continue, but sleep prevention is unavailable.",
        level: "error",
      },
    ]);
  });

  test("names the failed operation and its code", async () => {
    const pi = harness();
    await pi.emit("agent_start");
    pi.spawned[0]?.child.fail("start", "EAGAIN");
    await pi.emit("agent_start");
    pi.spawned[1]?.child.fail("stop", "EPERM");

    expect(pi.notifications).toStrictEqual([
      {
        message:
          "Coffee: Could not start caffeinate (EAGAIN). Check macOS process permissions and resources; Pi can continue, but sleep prevention may be unavailable.",
        level: "error",
      },
      {
        message:
          "Coffee: Could not stop caffeinate (EPERM). Check macOS process permissions and resources; Pi can continue, but sleep prevention may be unavailable.",
        level: "error",
      },
    ]);
  });

  test("does not reflect arbitrary system error codes or causes in notifications", () => {
    const cause = new Error("https://user:password@example.com/ private cause");
    const error = new CaffeinateProcessError("start", "secret\u001b[2J", cause);
    expect(error._tag).toBe("CaffeinateProcessError");
    expect(error.code).toBe("secret\u001b[2J");
    expect(error.cause).toBe(cause);
    expect(error.message).toContain("system error");
    expect(error.message).toContain("Pi can continue");
    expect(error.message).not.toMatch(/secret|password|\p{Cc}/u);
  });

  test("stays silent without a UI", async () => {
    const pi = harness("darwin", false);
    await pi.emit("agent_start");

    pi.spawned[0]?.child.fail("start", "EACCES");

    expect(pi.notifications).toStrictEqual([]);
  });
});

describe("/coffee command", () => {
  test("an empty argument toggles, starting from on", async () => {
    const pi = harness();

    await pi.command("");
    await pi.command("  ");

    expect(pi.notifications).toStrictEqual([
      { message: "Coffee is off for this session.", level: "info" },
      { message: "Coffee is on for this session.", level: "info" },
    ]);
  });

  test("rejects any other argument without changing state", async () => {
    const pi = harness();

    await pi.command("maybe");
    await pi.emit("agent_start");

    expect(pi.notifications).toStrictEqual([
      { message: "Usage: /coffee [on|off]", level: "warning" },
    ]);
    expect(pi.spawned).toHaveLength(1);
  });

  test("off stops the running child at once and prevents new ones", async () => {
    const pi = harness();
    await pi.emit("agent_start");
    pi.setIdle(false);

    await pi.command("off");
    expect(pi.spawned[0]?.child.stops).toBe(1);

    await pi.emit("agent_start");
    await pi.command("off");
    expect(pi.spawned).toHaveLength(1);
    expect(pi.notifications.filter((note) => note.level !== "info")).toStrictEqual([]);
  });

  test("on while an agent run is active starts sleep prevention immediately", async () => {
    const pi = harness();
    await pi.command("off");
    pi.setIdle(false);

    await pi.command("on");
    expect(pi.spawned).toHaveLength(1);
    expect(pi.spawned[0]?.args).toStrictEqual(["-i", "-s", "-w", "9876"]);

    await pi.command("on");
    await pi.emit("agent_start");
    expect(pi.spawned).toHaveLength(1);

    pi.setIdle(true);
    await pi.emit("agent_settled");
    expect(pi.spawned[0]?.child.stops).toBe(1);
  });

  test("on while idle waits for the next agent run", async () => {
    const pi = harness();
    await pi.command("off");

    await pi.command("on");
    expect(pi.spawned).toHaveLength(0);

    await pi.emit("agent_start");
    expect(pi.spawned).toHaveLength(1);
  });
});
