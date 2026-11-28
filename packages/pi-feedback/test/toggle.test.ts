import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FEEDBACK_TOOL, registerFeedback } from "../feedback.ts";
import type { FeedbackParams } from "../feedback.ts";
import { ledgerPath, readLedger } from "../ledger.ts";
import { fakeClock } from "./events.ts";
import { fakePi } from "./fake-pi.ts";

const PACKAGES = "/repo/packages";
const FEEDBACK_TOGGLE_TYPE = "pi-feedback-toggle";
const BUILTINS = ["read", "bash"];
const WITH_TOOL = [...BUILTINS, FEEDBACK_TOOL];

const params: FeedbackParams = {
  kind: "workaround",
  component: "pi-claude",
  summary: "Scratch path changed between turns",
  expected: "One scratch path per session",
  actual: "ENOENT on a path from an earlier turn",
  impact: "slowed",
};

function exchange(session: SessionManager, text: string): string {
  session.appendMessage({ role: "user", content: text, timestamp: 0 });

  return session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    api: "anthropic-messages",
    provider: "claude",
    model: "claude",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  });
}

describe("/feedback for the whole session", () => {
  let root: string;
  let ledger: string;

  const registered = (session: SessionManager, excluded: ReadonlyArray<string> = []) => {
    const pi = fakePi(PACKAGES, root, session, excluded);
    registerFeedback(pi.pi, {
      ledger,
      packagesDir: PACKAGES,
      ownPackages: ["pi-claude", "pi-feedback"],
      agentDir: root,
      home: root,
      piVersion: "1.6.0",
      clock: fakeClock(),
    });

    return pi;
  };

  const signals = async () => {
    const { events } = await readLedger(ledger);

    return events.length;
  };

  const expectOff = async (pi: ReturnType<typeof registered>) => {
    const before = await signals();
    await pi.end("read", true, "ENOENT");
    await expect(pi.call(params)).resolves.toMatchObject({ details: { status: "off" } });
    await expect(signals()).resolves.toBe(before);
    expect(pi.active()).not.toContain(FEEDBACK_TOOL);
  };

  const expectRecording = async (pi: ReturnType<typeof registered>) => {
    const before = await signals();
    await pi.end("read", true, "ENOENT");
    await expect(signals()).resolves.toBe(before + 1);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-feedback-toggle-"));
    ledger = ledgerPath(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("stays off after reopening the session file in a new process", async () => {
    const file = join(root, "session.jsonl");
    const session = SessionManager.open(file);
    exchange(session, "first");
    const original = registered(session);
    original.start("startup");
    await original.command("off");
    exchange(session, "after off");
    session.appendCompaction("Offline summary", null, 0);

    const reopened = registered(SessionManager.open(file));
    reopened.start("resume", WITH_TOOL);
    await expectOff(reopened);
  });

  test("stays off after /reload re-activates the tool", async () => {
    const session = SessionManager.inMemory("/repo", { id: "session-a" });
    exchange(session, "first");
    await registered(session).command("off");

    const reloaded = registered(session);
    reloaded.start("reload", WITH_TOOL);
    await expectOff(reloaded);
  });

  test("stays off when /tree restores a checkpoint that declared the tool", async () => {
    const session = SessionManager.inMemory("/repo", { id: "session-a" });
    const before = exchange(session, "before off");
    const visible = exchange(session, "last answer");
    const pi = registered(session);
    pi.start("startup");
    await pi.command("off");

    pi.tree(visible, WITH_TOOL);
    await expectOff(pi);
    pi.tree(before, WITH_TOOL);
    await expectOff(pi);
    pi.tree(null, WITH_TOOL);
    await expectOff(pi);
  });

  test("restoring off keeps a restored tool that registers later", async () => {
    const session = SessionManager.inMemory("/repo", { id: "session-a" });
    exchange(session, "first");
    await registered(session).command("off");

    const reopened = registered(session);
    reopened.start("resume", [...WITH_TOOL, "late_tool"]);
    await expectOff(reopened);
    expect(reopened.pending()).toStrictEqual(["late_tool"]);
    reopened.registerLate("late_tool");
    expect(reopened.active()).toContain("late_tool");
  });

  test("/feedback off keeps a restored tool that registers later", async () => {
    const session = SessionManager.inMemory("/repo", { id: "session-a" });
    exchange(session, "first");
    const pi = registered(session);
    pi.start("resume", [...WITH_TOOL, "late_tool"]);
    await pi.command("off");

    await expectOff(pi);
    pi.registerLate("late_tool");
    expect(pi.active()).toContain("late_tool");
  });

  test("/feedback on after off records and shows the tool again, also after reopen", async () => {
    const session = SessionManager.inMemory("/repo", { id: "session-a" });
    exchange(session, "before");
    const pi = registered(session);
    pi.start("startup");
    await pi.command("off");
    await pi.command("on");
    await expectRecording(pi);
    expect(pi.active().filter((name) => name === FEEDBACK_TOOL)).toHaveLength(1);
    exchange(session, "after on");

    const reopened = registered(session);
    reopened.start("resume", WITH_TOOL);
    await expectRecording(reopened);
    expect(reopened.active()).toContain(FEEDBACK_TOOL);
  });

  test("/feedback on asks Pi to declare a tool its restored loadout left out", async () => {
    const session = SessionManager.inMemory("/repo", { id: "session-a" });
    exchange(session, "first");
    const pi = registered(session);
    pi.start("resume", [...BUILTINS, "late_tool"]);
    expect(pi.active()).not.toContain(FEEDBACK_TOOL);

    await pi.command("on");
    await expectRecording(pi);
    expect(pi.active()).toContain(FEEDBACK_TOOL);
    pi.registerLate("late_tool");
    expect(pi.active()).toContain("late_tool");
  });

  test("/feedback on cannot declare a tool that Pi's filters keep unregistered", async () => {
    const session = SessionManager.inMemory("/repo", { id: "session-a" });
    exchange(session, "first");
    const pi = registered(session, [FEEDBACK_TOOL]);
    pi.start("startup", BUILTINS);
    await pi.command("off");
    await pi.command("on");

    await expectRecording(pi);
    expect(pi.active()).toStrictEqual(BUILTINS);
  });

  test.each([
    ["a fork", (points: { afterOff: string; tip: string }) => points.afterOff],
    ["a clone", (points: { afterOff: string; tip: string }) => points.tip],
  ])("%s of an off session records but keeps Pi's restored loadout", async (_name, at) => {
    const session = SessionManager.inMemory("/repo", { id: "session-a" });
    exchange(session, "first");
    await registered(session).command("off");
    const afterOff = exchange(session, "after off");
    const tip = exchange(session, "fork anchor");

    session.createBranchedSession(at({ afterOff, tip }));
    expect(session.getSessionId()).not.toBe("session-a");
    expect(session.getEntries().filter((entry) => entry.type === "custom")).toHaveLength(1);
    const forked = registered(session);
    const restoredUnderNegativeToolsModifier = BUILTINS;
    forked.start("fork", restoredUnderNegativeToolsModifier);
    await expectRecording(forked);
    expect(forked.active()).toStrictEqual(BUILTINS);
  });

  test("a fork with no copied setting records and keeps Pi's restored loadout", async () => {
    const session = SessionManager.inMemory("/repo", { id: "session-a" });
    const anchor = exchange(session, "before any change");
    const parent = registered(session);
    parent.start("startup");
    await parent.command("off");
    session.branch(anchor);
    const diverged = exchange(session, "diverged while off");

    session.createBranchedSession(diverged);
    expect(session.getEntries().some((entry) => entry.type === "custom")).toBe(false);
    const forked = registered(session);
    forked.start("fork", BUILTINS);
    await expectRecording(forked);
    expect(forked.active()).toStrictEqual(BUILTINS);
  });

  test("/new starts on with the tool declared", async () => {
    const session = SessionManager.inMemory("/repo", { id: "session-a" });
    exchange(session, "first");
    await registered(session).command("off");

    session.newSession({ id: "session-b" });
    const fresh = registered(session);
    fresh.start("new");
    await expectRecording(fresh);
    expect(fresh.active()).toContain(FEEDBACK_TOOL);
  });

  test("leaves the tool list alone in a session with no saved setting", async () => {
    const session = SessionManager.inMemory("/repo", { id: "session-a" });
    exchange(session, "first");
    const pi = registered(session);
    pi.start("startup", ["read"]);
    pi.tree(null, ["bash"]);
    expect(pi.active()).toStrictEqual(["bash"]);
    await expectRecording(pi);
  });

  test("ignores malformed, unknown-version and other-session records", async () => {
    const session = SessionManager.inMemory("/repo", { id: "session-a" });
    exchange(session, "first");

    for (const data of [
      { version: 2, enabled: false, sessionId: "session-a" },
      { version: 1, enabled: "off", sessionId: "session-a" },
      { version: 1, enabled: false },
      { version: 1, enabled: false, sessionId: "session-other" },
      undefined,
    ]) {
      session.appendCustomEntry(FEEDBACK_TOGGLE_TYPE, data);
    }

    const pi = registered(session);
    pi.start("resume", WITH_TOOL);
    await expectRecording(pi);
    expect(pi.active()).toStrictEqual(WITH_TOOL);
  });

  test("an unsaved off still stops recording, hides the tool and says it was not saved", async () => {
    const session = SessionManager.inMemory("/repo", { id: "session-a" });
    const pi = registered(session);
    pi.start("startup");
    pi.failAppends(new Error("synthetic full disk"));
    await pi.command("off");

    await expectOff(pi);
    pi.tree(null, WITH_TOOL);
    await expectOff(pi);
    expect(pi.notifications).toStrictEqual([
      {
        message:
          "Harness feedback is off for now, but the setting could not be saved: synthetic full disk. Reopening or reloading this session restores the last saved setting.",
        level: "warning",
      },
    ]);
  });

  test("a saved change after a failed save confirms it cleanly", async () => {
    const session = SessionManager.inMemory("/repo", { id: "session-a" });
    const pi = registered(session);
    pi.start("startup");
    pi.failAppends(new Error("synthetic full disk"));
    await pi.command("off");
    pi.failAppends(undefined);
    await pi.command("on");

    expect(pi.notifications.at(-1)).toStrictEqual({
      message: `Harness feedback is on for this session. Ledger: ${ledger}.`,
      level: "info",
    });
    expect(pi.notes).toStrictEqual([
      {
        customType: FEEDBACK_TOGGLE_TYPE,
        data: { version: 1, enabled: true, sessionId: "session-a" },
      },
    ]);
  });

  test("saves one versioned record per change and confirms it for this session", async () => {
    const session = SessionManager.inMemory("/repo", { id: "session-a" });
    const pi = registered(session);
    await pi.command("off");
    await pi.command("");

    expect(pi.notes).toStrictEqual([
      {
        customType: FEEDBACK_TOGGLE_TYPE,
        data: { version: 1, enabled: false, sessionId: "session-a" },
      },
      {
        customType: FEEDBACK_TOGGLE_TYPE,
        data: { version: 1, enabled: true, sessionId: "session-a" },
      },
    ]);
    expect(pi.notifications.map((note) => note.message)).toStrictEqual([
      `Harness feedback is off for this session. Ledger: ${ledger}.`,
      `Harness feedback is on for this session. Ledger: ${ledger}.`,
    ]);
  });
});
