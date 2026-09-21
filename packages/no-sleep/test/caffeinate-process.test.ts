import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, test, vi } from "vitest";
import { caffeinateSpawner } from "../caffeinate-process";
import noSleep from "../index";
import type { CaffeinateEnd, CaffeinateProcess } from "../no-sleep-lifecycle";
import { fakePi } from "./fake-pi";

const KILL_GRACE_MS = 50;
const spawnNode = caffeinateSpawner(process.execPath, KILL_GRACE_MS);
const IDLE_FOREVER = "setInterval(() => {}, 1000)";

function ended(child: CaffeinateProcess): Promise<CaffeinateEnd> {
  return new Promise((resolve) => child.onEnd(resolve));
}

describe("caffeinate process adapter", () => {
  test("reports the exit of a child that stops by itself", async () => {
    const end = await ended(spawnNode(["-e", "process.exit(3)"]));

    expect(end).toEqual({ _tag: "exited", code: 3, signal: null });
  });

  test("stops a running child with SIGTERM", async () => {
    const child = spawnNode(["-e", IDLE_FOREVER]);
    const end = ended(child);

    child.stop();

    expect(await end).toEqual({ _tag: "exited", code: null, signal: "SIGTERM" });
    child.stop();
  });

  test("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const directory = mkdtempSync(join(tmpdir(), "no-sleep-"));
    const ready = join(directory, "ready");
    try {
      const child = spawnNode([
        "-e",
        `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1], ""); ${IDLE_FOREVER}`,
        ready,
      ]);
      const end = ended(child);
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 5_000 });

      child.stop();

      expect(await end).toEqual({ _tag: "exited", code: null, signal: "SIGKILL" });
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  test("reports a command that cannot be spawned", async () => {
    const child = caffeinateSpawner("/nonexistent/caffeinate", KILL_GRACE_MS)([]);

    const end = await ended(child);

    expect(end).toMatchObject({ _tag: "failed", error: { _tag: "CaffeinateProcessError" } });
    expect(end._tag === "failed" && end.error.cause).toMatchObject({ code: "ENOENT" });
    child.stop();
  });

  test("reports a synchronous spawn failure through the same channel", async () => {
    const child = caffeinateSpawner("", KILL_GRACE_MS)([]);

    const end = await ended(child);

    expect(end).toMatchObject({ _tag: "failed", error: { _tag: "CaffeinateProcessError" } });
    child.stop();
  });
});

describe("no-sleep entry point", () => {
  const caffeinateIsRunning = (): boolean =>
    spawnSync("pgrep", ["-f", `caffeinate -d -i -s -w ${process.pid}`]).status === 0;

  test.runIf(process.platform === "darwin")(
    "holds a real caffeinate assertion while the agent works",
    async () => {
      const pi = fakePi();
      noSleep(pi.pi);

      await pi.emit("agent_start");
      await vi.waitFor(() => expect(caffeinateIsRunning()).toBe(true));

      await pi.emit("agent_settled");
      await vi.waitFor(() => expect(caffeinateIsRunning()).toBe(false));
      expect(pi.notifications).toEqual([]);
    },
  );

  test.runIf(process.platform !== "darwin")("registers nothing outside macOS", () => {
    const pi = fakePi();
    noSleep(pi.pi);

    expect(pi.registeredEvents()).toEqual([]);
  });
});
