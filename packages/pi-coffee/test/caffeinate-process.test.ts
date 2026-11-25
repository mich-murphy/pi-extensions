import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { assert, describe, expect, test, vi } from "vitest";
import { caffeinateSpawner } from "../caffeinate-process";
import { CaffeinateNotice } from "../coffee-lifecycle";
import type { CaffeinateProcess } from "../coffee-lifecycle";
import coffee from "../index";
import { fakePi } from "./fake-pi";

const KILL_GRACE_MS = 50;
const spawnNode = caffeinateSpawner(process.execPath, KILL_GRACE_MS);
const IDLE_FOREVER = "setInterval(() => {}, 1000)";
const POLL_UNTIL_TRUE_WITH_LOADED_MACHINE_HANG_GUARD = { timeout: 20_000 };
const OBSERVE_TEST_TIMEOUT_MS = 30_000;

async function ended(child: CaffeinateProcess): Promise<CaffeinateNotice> {
  return new Promise((resolve) => {
    child.onNotice(resolve);
  });
}

function caffeinateIsRunning(): boolean {
  return spawnSync("pgrep", ["-f", `caffeinate -i -s -w ${process.pid}`]).status === 0;
}

describe("caffeinate process adapter", () => {
  test("reports the exit of a child that stops by itself", async () => {
    const end = await ended(spawnNode(["-e", "process.exit(3)"]));

    expect(end).toStrictEqual(CaffeinateNotice.exited({ code: 3, signal: null }));
  });

  test("stops a running child with SIGTERM", async () => {
    const child = spawnNode(["-e", IDLE_FOREVER]);
    const end = ended(child);

    child.stop();

    await expect(end).resolves.toStrictEqual(
      CaffeinateNotice.exited({ code: null, signal: "SIGTERM" }),
    );
    child.stop();
  });

  test(
    "escalates to SIGKILL when the child ignores SIGTERM",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "coffee-"));
      const ready = join(directory, "ready");
      try {
        const child = spawnNode([
          "-e",
          `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1], ""); ${IDLE_FOREVER}`,
          ready,
        ]);
        const end = ended(child);
        await vi.waitFor(() => {
          expect(existsSync(ready)).toBe(true);
        }, POLL_UNTIL_TRUE_WITH_LOADED_MACHINE_HANG_GUARD);

        child.stop();

        await expect(end).resolves.toStrictEqual(
          CaffeinateNotice.exited({ code: null, signal: "SIGKILL" }),
        );
      } finally {
        rmSync(directory, { recursive: true });
      }
    },
    OBSERVE_TEST_TIMEOUT_MS,
  );

  test("reports a missing command as caffeinate being unavailable", async () => {
    const child = caffeinateSpawner("/nonexistent/caffeinate", KILL_GRACE_MS)([]);

    const end = await ended(child);

    assert(CaffeinateNotice.$is("failed")(end));
    expect(end.error._tag).toBe("CaffeinateProcessError");
    expect(end.error).toMatchObject({ operation: "start", code: "ENOENT" });
    expect(end.error.message).toBe(
      "/usr/bin/caffeinate was not found, so sleep prevention is unavailable.",
    );
    child.stop();
  });

  test("reports a synchronous spawn failure through the same channel", async () => {
    const child = spawnNode(["x".repeat(5_000_000)]);

    const end = await ended(child);

    assert(CaffeinateNotice.$is("failed")(end));
    expect(end.error).toMatchObject({ operation: "start", code: "E2BIG" });
    expect(end.error.message).toBe(
      "Could not start caffeinate (E2BIG). Sleep is allowed until the next agent run.",
    );
    child.stop();
  });

  test("propagates an invalid command as a defect", () => {
    expect(() => caffeinateSpawner("", KILL_GRACE_MS)([])).toThrow(TypeError);
  });
});

describe("coffee entry point", () => {
  test.runIf(process.platform === "darwin")(
    "holds a real caffeinate assertion while the agent works",
    async () => {
      const pi = fakePi();
      coffee(pi.pi);

      await pi.emit("agent_start");
      await vi.waitFor(() => {
        expect(caffeinateIsRunning()).toBe(true);
      }, POLL_UNTIL_TRUE_WITH_LOADED_MACHINE_HANG_GUARD);

      await pi.emit("agent_settled");
      await vi.waitFor(() => {
        expect(caffeinateIsRunning()).toBe(false);
      }, POLL_UNTIL_TRUE_WITH_LOADED_MACHINE_HANG_GUARD);
      expect(pi.notifications).toStrictEqual([]);
    },
    OBSERVE_TEST_TIMEOUT_MS,
  );

  test.runIf(process.platform !== "darwin")("registers only /coffee outside macOS", () => {
    const pi = fakePi();
    coffee(pi.pi);

    expect(pi.registeredEvents()).toStrictEqual([]);
    expect(pi.registeredCommands()).toStrictEqual(["coffee"]);
  });
});
