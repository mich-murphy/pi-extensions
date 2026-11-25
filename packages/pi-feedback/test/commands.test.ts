import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCli } from "../commands.ts";
import type { CliIo } from "../commands.ts";
import { groupId } from "../fingerprint.ts";
import { ledgerPath, readLedger } from "../ledger.ts";
import type { LedgerEvent } from "../ledger.ts";
import { signal } from "./events.ts";

const execFileAsync = promisify(execFile);
const CLI = new URL("../cli.ts", import.meta.url).pathname;
const claudeGroup = groupId("pi-claude", "read: ENOENT");

function write(file: string, events: readonly LedgerEvent[]): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, events.map((event) => `${JSON.stringify(event)}\n`).join(""));
}

describe("pi-feedback commands", () => {
  let root: string;
  let io: CliIo & { stdout: string; stderr: string };

  async function run(...args: string[]): Promise<number> {
    io.stdout = "";
    io.stderr = "";
    return runCli(args, io);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-feedback-cli-"));
    const state = { stdout: "", stderr: "" };
    io = Object.assign(state, {
      ledger: join(root, "ledger.jsonl"),
      out: (text: string) => {
        state.stdout += text;
      },
      err: (text: string) => {
        state.stderr += text;
      },
    });
    write(io.ledger, [signal({ n: 1, session: "a" }), signal({ n: 2, session: "b" })]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("prints the queue as a table", async () => {
    await expect(run("queue")).resolves.toBe(0);
    expect(io.stdout.split("\n")[0]).toMatch(/^READY\s+RANK\s+SESSIONS\s+RECORDS\s+STATUS/u);
    expect(io.stdout).toContain(
      `yes    4     2         2        open    pi-claude  ${claudeGroup}`,
    );
  });

  test("prints the queue as JSON", async () => {
    await run("queue", "--json");
    expect(JSON.parse(io.stdout)).toMatchObject([{ id: claudeGroup, ready: true }]);
  });

  test("reads several ledgers together and reports unreadable lines", async () => {
    const other = join(root, "other.jsonl");
    write(other, [signal({ n: 3, session: "c" })]);
    appendFileSync(other, "{broken\n");
    await run("queue", "--json", io.ledger, other);
    expect(JSON.parse(io.stdout)).toMatchObject([{ sessions: 3, records: 3 }]);
    expect(io.stderr).toBe("Skipped 1 unreadable ledger lines.\n");
  });

  test("resolves a group, hides it, and shows it with --all", async () => {
    await expect(run("resolve", claudeGroup, "abc1234", "types")).resolves.toBe(0);
    expect(io.stdout).toBe(`Resolved ${claudeGroup} with abc1234 (types).\n`);
    await run("queue");
    expect(io.stdout).toBe("No open groups.\n");
    await run("queue", "--all", "--json");
    expect(JSON.parse(io.stdout)).toMatchObject([{ status: "resolved" }]);
  });

  test("reopens a resolved group", async () => {
    await run("resolve", claudeGroup, "abc1234", "lint");
    await expect(run("reopen", claudeGroup, "still", "happens")).resolves.toBe(0);
    const { events } = await readLedger(io.ledger);
    expect(events.at(-1)).toMatchObject({ type: "reopen", reason: "still happens" });
  });

  test.each([
    [["resolve", "0123456789ab", "abc1234", "types"]],
    [["reopen", "0123456789ab", "why"]],
  ])("refuses an unknown group: %j", async (args) => {
    await expect(run(...args)).resolves.toBe(1);
    expect(io.stderr).toContain("No group 0123456789ab");
  });

  test.each([
    [["resolve", claudeGroup, "abc1234"]],
    [["resolve", claudeGroup, "abc1234", "prose"]],
    [["resolve", claudeGroup, "abc1234", "types", "extra"]],
    [["reopen", claudeGroup]],
    [["queue", "--verbose"]],
    [["unknown"]],
  ])("rejects bad arguments: %j", async (args) => {
    await expect(run(...args)).resolves.toBe(2);
    expect(io.stderr).toContain("Usage:");
  });

  test("rejects a commit the ledger cannot store", async () => {
    await expect(run("resolve", claudeGroup, "not-a-commit", "types")).resolves.toBe(2);
    expect(io.stderr).toBe("Not a valid resolve event for the feedback ledger.\n");
  });

  test.each([[[]], [["help"]], [["--help"]]])("prints usage for %j", async (args) => {
    await expect(run(...args)).resolves.toBe(0);
    expect(io.stdout).toContain("pi-feedback queue");
  });

  test("runs as a script against the agent directory", async () => {
    write(ledgerPath(root), [signal({ n: 1, session: "a" })]);
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", CLI, "queue", "--json"],
      { env: { ...process.env, PI_CODING_AGENT_DIR: root } },
    );
    expect(JSON.parse(stdout)).toMatchObject([{ id: claudeGroup, records: 1 }]);
  });
});
