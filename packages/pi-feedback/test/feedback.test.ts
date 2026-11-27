import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, expectTypeOf, test } from "vitest";
import {
  errorText,
  FEEDBACK_NOTE_TYPE,
  FEEDBACK_TOOL,
  registerFeedback,
  REPORTS_PER_SESSION,
} from "../feedback.ts";
import type { FeedbackParams, FeedbackRegistration } from "../feedback.ts";
import { groupId, reportFingerprint } from "../fingerprint.ts";
import { ledgerPath, readLedger } from "../ledger.ts";
import { fakeClock } from "./events.ts";
import { fakePi } from "./fake-pi.ts";

const PACKAGES = "/repo/packages";

async function ledgerEvents(file: string) {
  const read = await readLedger(file);

  return read.events;
}

const params: FeedbackParams = {
  kind: "workaround",
  component: "pi-claude",
  summary: "Scratch path changed between turns",
  expected: "One scratch path per session",
  actual: "ENOENT on a path from an earlier turn",
  impact: "slowed",
};

describe("harness feedback extension", () => {
  let root: string;
  let ledger: string;
  let pi: ReturnType<typeof fakePi>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-feedback-ext-"));
    ledger = ledgerPath(root);
    pi = fakePi(PACKAGES);
    registerFeedback(pi.pi, {
      ledger,
      packagesDir: PACKAGES,
      ownPackages: ["pi-claude", "pi-web", "pi-feedback", "pi-skills"],
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

  test("fits Pi's extension API", () => {
    expectTypeOf<ExtensionAPI>().toExtend<FeedbackRegistration>();
  });

  test("registers an active tool that names itself in its guidelines", () => {
    const [tool] = pi.tools;
    expect(tool?.name).toBe(FEEDBACK_TOOL);
    expect(pi.active()).toContain(FEEDBACK_TOOL);

    const unnamed = pi.tools
      .flatMap((registered) => registered.promptGuidelines)
      .filter((guideline) => !guideline.includes(FEEDBACK_TOOL));

    expect(unnamed).toStrictEqual([]);
  });

  test("records a report with its owner, context and a session note", async () => {
    const result = await pi.call({ ...params, workaround: "Re-created the file" });
    const group = groupId("pi-claude", reportFingerprint("pi-claude", "workaround"));
    expect(result.details).toStrictEqual({ status: "recorded", group, owner: "pi-claude" });
    expect(result.isError).toBeUndefined();
    const { events } = await readLedger(ledger);
    expect(events).toMatchObject([
      {
        type: "report",
        session: "session-a",
        owner: "pi-claude",
        workaround: "Re-created the file",
        model: "claude/claude-opus-5-5",
        piVersion: "1.6.0",
      },
    ]);
    expect(pi.notes).toStrictEqual([
      {
        customType: FEEDBACK_NOTE_TYPE,
        data: { group, owner: "pi-claude", summary: params.summary },
      },
    ]);
  });

  test.each([
    ["an extension package named first", "pi-web: webfetch rescue", "pi-web"],
    ["a tool one of our extensions registered", "webfetch", "pi-web"],
    ["a Pi built-in tool", "read", "unattributed"],
    ["a tool from outside this repository", "outside", "unattributed"],
    ["an instruction file", "AGENTS.md", "unattributed"],
  ])("attributes %s", async (_name, component, owner) => {
    const result = await pi.call({ ...params, component });
    expect(result.details).toMatchObject({ status: "recorded", owner });
  });

  test("ignores a repeat of the same report in one session", async () => {
    await pi.call(params);
    const repeat = await pi.call({ ...params, summary: `  ${params.summary.toUpperCase()} ` });
    expect(repeat.details).toStrictEqual({ status: "duplicate" });
    pi.useSession("session-b");
    await expect(pi.call(params)).resolves.toMatchObject({ details: { status: "recorded" } });
    await expect(ledgerEvents(ledger)).resolves.toHaveLength(2);
  });

  test(`stops after ${REPORTS_PER_SESSION} reports in one session`, async () => {
    for (let n = 0; n < REPORTS_PER_SESSION; n += 1) {
      await pi.call({ ...params, summary: `report ${n}` });
    }

    const over = await pi.call({ ...params, summary: "one more" });
    expect(over.details).toStrictEqual({ status: "limit" });
    await expect(ledgerEvents(ledger)).resolves.toHaveLength(REPORTS_PER_SESSION);
  });

  test("reports a ledger it cannot write as an error and lets the agent retry", async () => {
    mkdirSync(dirname(ledger), { recursive: true });
    chmodSync(dirname(ledger), 0o500);
    const failed = await pi.call(params);
    expect(failed).toMatchObject({ isError: true, details: { status: "failed" } });
    expect(pi.notes).toHaveLength(0);
    chmodSync(dirname(ledger), 0o700);
    await expect(pi.call(params)).resolves.toMatchObject({ details: { status: "recorded" } });
  });

  test("records failed tool calls as signals and skips successes", async () => {
    await pi.end("webfetch", true, "Request failed (404 Not Found).");
    await pi.end("read", true, "ENOENT: no such file '/tmp/a/b.png'");
    await pi.end("read", false, "fine");
    await pi.end(FEEDBACK_TOOL, true, "Could not record");
    const { events } = await readLedger(ledger);
    expect(events).toMatchObject([
      { type: "signal", tool: "webfetch", owner: "pi-web", piVersion: "1.6.0" },
      {
        type: "signal",
        tool: "read",
        owner: "unattributed",
        fingerprint: "read: ENOENT: no such file '<path>'",
      },
    ]);
  });

  test("marks a read of a file a sibling call in the same batch writes", async () => {
    const scratch = "/tmp/claude-1/-home-u-dev-x/0a1b/scratchpad";
    const missing = `ENOENT: no such file or directory, access '${scratch}/z5.png'`;
    pi.batch([
      { id: "b1", name: "bash", args: { command: `S=${scratch}; sips x --out $S/z5.png` } },
      { id: "r1", name: "read", args: { path: `${scratch}/z5.png` } },
    ]);
    await pi.end("read", true, missing, "r1");
    pi.batch([{ id: "r2", name: "read", args: { path: `${scratch}/z5.png` } }]);
    await pi.end("read", true, missing, "r2");
    const { events } = await readLedger(ledger);
    expect(events).toMatchObject([
      { owner: "pi-claude", cause: "parallel-batch" },
      { owner: "pi-claude" },
    ]);
    expect(events[1]).not.toHaveProperty("cause");
  });

  test("keeps the batch while its tool results arrive", async () => {
    const scratch = "/tmp/claude-1/-home-u-dev-x/0a1b/scratchpad";
    pi.batch([
      { id: "b1", name: "bash", args: { command: `mkdir -p ${scratch}` } },
      { id: "r1", name: "read", args: { path: `${scratch}/a.png` } },
    ]);
    pi.toolResult("b1");
    await pi.end("read", true, `ENOENT: '${scratch}/a.png'`, "r1");
    await expect(ledgerEvents(ledger)).resolves.toMatchObject([{ cause: "parallel-batch" }]);
  });

  test("forgets the batch when a reply has no tool calls", async () => {
    const scratch = "/tmp/claude-1/-home-u-dev-x/0a1b/scratchpad";
    pi.batch([
      { id: "b1", name: "bash", args: { command: `mkdir -p ${scratch}` } },
      { id: "r1", name: "read", args: { path: `${scratch}/a.png` } },
    ]);
    pi.batch([]);
    await pi.end("read", true, `ENOENT: '${scratch}/a.png'`, "r1");
    const events = await ledgerEvents(ledger);
    expect(events[0]).not.toHaveProperty("cause");
  });

  test("marks a report that names a Pi path as Pi evidence", async () => {
    await pi.call({
      ...params,
      component: "read",
      actual: "ENOENT: /home/u/.pi/agent/sessions/x.jsonl",
    });
    await expect(ledgerEvents(ledger)).resolves.toMatchObject([
      { type: "report", owner: "unattributed", evidence: "pi-path" },
    ]);
  });

  test("counts signals it could not write and shows the count in /feedback", async () => {
    mkdirSync(dirname(ledger), { recursive: true });
    chmodSync(dirname(ledger), 0o500);
    await pi.end("read", true, "ENOENT");
    chmodSync(dirname(ledger), 0o700);
    await pi.command("on");
    expect(pi.notifications.at(-1)?.message).toContain("1 tool errors could not be written to it.");
  });

  test("/feedback off hides the tool, stops recording and names the ledger", async () => {
    await pi.command("off");
    expect(pi.notifications).toStrictEqual([
      { message: `Harness feedback is off for this session. Ledger: ${ledger}.`, level: "info" },
    ]);
    expect(pi.active()).not.toContain(FEEDBACK_TOOL);
    await pi.end("read", true, "ENOENT");
    await expect(pi.call(params)).resolves.toMatchObject({ details: { status: "off" } });
    await expect(ledgerEvents(ledger)).resolves.toHaveLength(0);

    await pi.command("on");
    await pi.command("on");
    expect(pi.active().filter((name) => name === FEEDBACK_TOOL)).toHaveLength(1);
    await pi.end("read", true, "ENOENT");
    await expect(ledgerEvents(ledger)).resolves.toHaveLength(1);
  });

  test("renders a filed note and ignores malformed entries", () => {
    expect(
      pi.render(FEEDBACK_NOTE_TYPE, {
        group: "0123456789ab",
        owner: "pi-claude",
        summary: "Scratch",
      }),
    ).toBe("Harness feedback filed (pi-claude, 0123456789ab) Scratch");
    expect(pi.render(FEEDBACK_NOTE_TYPE, { group: 1 })).toBe("");
  });
});

describe("whether a named Pi path existed", () => {
  let root: string;
  let agentDir: string;
  let ledger: string;
  let pi: ReturnType<typeof fakePi>;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pi-feedback-path-")));
    agentDir = join(root, ".pi", "agent");
    mkdirSync(join(agentDir, "sessions"), { recursive: true });
    writeFileSync(join(agentDir, "sessions", "here.jsonl"), "");
    ledger = ledgerPath(join(root, "ledger"));
    pi = fakePi(PACKAGES, agentDir);
    registerFeedback(pi.pi, {
      ledger,
      packagesDir: PACKAGES,
      ownPackages: ["pi-claude"],
      agentDir,
      home: root,
      piVersion: "1.6.0",
      clock: fakeClock(),
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("records that every Pi path a failure names exists", async () => {
    await pi.end("read", true, `EACCES: permission denied, open '${agentDir}/sessions/here.jsonl'`);
    await expect(ledgerEvents(ledger)).resolves.toMatchObject([
      { owner: "unattributed", evidence: "pi-path", pathExisted: true },
    ]);
  });

  test("records that a named Pi path was missing", async () => {
    await pi.end(
      "read",
      true,
      `ENOENT: '${agentDir}/sessions/here.jsonl' and '${agentDir}/sessions/gone.jsonl'`,
    );
    await expect(ledgerEvents(ledger)).resolves.toMatchObject([
      { evidence: "pi-path", pathExisted: false },
    ]);
  });

  test("checks a report's Pi path too", async () => {
    await pi.call({
      ...params,
      component: "read",
      actual: `EACCES: ~/.pi/agent/sessions/here.jsonl`,
    });
    await expect(ledgerEvents(ledger)).resolves.toMatchObject([
      { type: "report", evidence: "pi-path", pathExisted: true },
    ]);
  });

  test("leaves the fact out when no Pi path is named", async () => {
    await pi.end("bash", true, "make: *** [all] Error 2");
    const [event] = await ledgerEvents(ledger);
    expect(event).not.toHaveProperty("pathExisted");
  });
});

describe("errorText", () => {
  test.each([
    [
      { content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] },
      "a\nb",
    ],
    [{ content: [{ type: "text", text: 1 }, null, { type: "text", text: "valid" }] }, "valid"],
    [{ content: "not a list" }, ""],
    [undefined, ""],
    ["text", ""],
  ])("reads %j as %j", (input, expected) => {
    expect(errorText(input)).toBe(expected);
  });
});
