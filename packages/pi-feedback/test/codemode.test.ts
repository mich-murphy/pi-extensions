import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { registerFeedback } from "../feedback.ts";
import type { FeedbackParams, FeedbackResult } from "../feedback.ts";
import { ledgerPath, readLedger } from "../ledger.ts";
import { fakeClock } from "./events.ts";
import { fakePi } from "./fake-pi.ts";

const PACKAGES = "/repo/packages";
const SCRATCH = "/tmp/claude-1/-home-u-dev-x/0a1b/scratchpad";
const MISSING = `ENOENT: no such file or directory, access '${SCRATCH}/z5.png'`;
const WRITE = { command: `sips x --out ${SCRATCH}/z5.png` };
const READ = { path: `${SCRATCH}/z5.png` };

const report: FeedbackParams = {
  kind: "tool_error",
  component: "pi-claude",
  summary: "Scratch path missing",
  expected: "The file",
  actual: "ENOENT",
  impact: "slowed",
};

async function signals(file: string) {
  const { events } = await readLedger(file);

  return events;
}

describe("harness feedback under codemode", () => {
  let root: string;
  let ledger: string;
  let pi: ReturnType<typeof fakePi>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-feedback-codemode-"));
    ledger = ledgerPath(root);
    pi = fakePi(PACKAGES);
    registerFeedback(pi.pi, {
      ledger,
      packagesDir: PACKAGES,
      ownPackages: ["pi-claude", "pi-feedback"],
      agentDir: "/home/u/.pi/agent",
      home: "/home/u",
      piVersion: "1.6.0",
      clock: fakeClock(),
    });
  });

  afterEach(() => {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  });

  test("gives scripts every status as structured content and keeps the text", async () => {
    mkdirSync(dirname(ledger), { recursive: true });
    chmodSync(dirname(ledger), 0o500);
    const results: FeedbackResult[] = [await pi.call(report)];
    chmodSync(dirname(ledger), 0o700);
    results.push(await pi.call(report), await pi.call(report));

    for (let n = 1; n < 5; n += 1) {
      await pi.call({ ...report, summary: `report ${n}` });
    }

    results.push(await pi.call({ ...report, summary: "over" }));
    await pi.command("off");
    results.push(await pi.call(report));

    expect(results.map((result) => result.structuredContent)).toStrictEqual(
      results.map((result) => result.details),
    );
    expect(results.map((result) => result.structuredContent.status)).toStrictEqual([
      "failed",
      "recorded",
      "duplicate",
      "limit",
      "off",
    ]);
    expect(results[1]?.structuredContent).toMatchObject({ owner: "pi-claude" });
    expect(results[1]?.content[0]?.text).toMatch(
      /^Recorded in group [0-9a-f]{12} \(owner pi-claude\)/u,
    );
    expect(results[0]?.isError).toBe(true);
    expect(pi.tools[0]?.outputSchema.required).toStrictEqual(["status"]);
  });

  test("marks a nested read that overlapped a nested writer and records the script once", async () => {
    pi.nestedStart("cm", "cm/1", "bash", WRITE);
    pi.nestedStart("cm", "cm/2", "read", READ);
    await pi.nestedEnd("cm", "cm/2", "read", true, MISSING);
    await pi.nestedEnd("cm", "cm/1", "bash", false, "done");
    await pi.end("codemode", true, `Script failed\nScript error:\n${MISSING}`, "cm");
    await expect(signals(ledger)).resolves.toMatchObject([
      { tool: "read", owner: "pi-claude", cause: "parallel-batch" },
    ]);
    await expect(signals(ledger)).resolves.toHaveLength(1);
  });

  test("leaves a nested read after its writer finished unmarked", async () => {
    pi.nestedStart("cm", "cm/1", "bash", WRITE);
    await pi.nestedEnd("cm", "cm/1", "bash", false, "done");
    pi.nestedStart("cm", "cm/2", "read", READ);
    await pi.nestedEnd("cm", "cm/2", "read", true, MISSING);
    pi.nestedStart("cm", "cm/3", "bash", WRITE);
    await pi.nestedEnd("cm", "cm/3", "bash", false, "done");
    const events = await signals(ledger);
    expect(events).toMatchObject([{ tool: "read" }]);
    expect(events[0]).not.toHaveProperty("cause");
  });

  test("records a script failure when none of its calls failed", async () => {
    pi.nestedStart("cm-a", "cm-a/1", "read", READ);
    await pi.nestedEnd("cm-a", "cm-a/1", "read", true, MISSING);
    await pi.end("codemode", true, "Script failed", "cm-a");
    pi.nestedStart("cm-b", "cm-b/1", "bash", WRITE);
    await pi.nestedEnd("cm-b", "cm-b/1", "bash", false, "done");
    await pi.end("codemode", true, "Script failed\nScript error:\nboom", "cm-b");
    await pi.end("codemode", true, "Script failed\nScript error:\nagain", "cm-a");
    await expect(signals(ledger)).resolves.toMatchObject([
      { tool: "read" },
      { tool: "codemode", error: "Script failed\nScript error:\nboom" },
      { tool: "codemode", error: "Script failed\nScript error:\nagain" },
    ]);
  });

  test("keeps the message batch for direct calls", async () => {
    pi.batch([
      { id: "b1", name: "bash", args: WRITE },
      { id: "r1", name: "read", args: READ },
    ]);
    pi.nestedStart("cm", "cm/1", "read", READ);
    await pi.end("read", true, MISSING, "r1");
    await expect(signals(ledger)).resolves.toMatchObject([{ cause: "parallel-batch" }]);
  });
});
