import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { USAGE_LIMIT_CHANNEL } from "../../shared/usage-limit";
import {
  RETRY_TYPE,
  CHECK_INTERVAL_MS,
  LEGACY_RETRY_TYPE,
  MAX_WAIT_MS,
  SETTING_TYPE,
  registerRetry,
} from "../retry";
import { assistantEntry, fakePi, userEntry } from "./fake-pi";
import type { TestUsageNotice } from "./fake-pi";

const MINUTE = CHECK_INTERVAL_MS;
const RESETS_AT = 90 * MINUTE;
const NOTICE = { provider: "claude", resetsAt: RESETS_AT };

function harness(mode: ExtensionContext["mode"] = "tui") {
  const pi = fakePi(mode);
  registerRetry(pi.pi, pi.deps);

  return pi;
}

function open(
  session: SessionManager,
  reason: SessionStartEvent["reason"] = "startup",
  mode: ExtensionContext["mode"] = "tui",
) {
  const pi = fakePi(mode, {}, session);
  registerRetry(pi.pi, pi.deps);
  pi.startSession(reason);

  return pi;
}

function savedFile(session: SessionManager): string {
  const file = session.getSessionFile();

  if (file === undefined) {
    throw new Error("test setup: the session has no file");
  }

  return file;
}

function say(session: SessionManager, content: string): string {
  return session.appendMessage({ role: "user", content, timestamp: 0 });
}

function failOnUsageLimit(pi: ReturnType<typeof harness>, notice: TestUsageNotice = NOTICE) {
  pi.startRun();
  pi.publish(USAGE_LIMIT_CHANNEL, notice);

  return pi.settle("error", [userEntry("u1"), assistantEntry("a1", "error")]);
}

const marker: AgentMessage = {
  role: "custom",
  customType: RETRY_TYPE,
  content: "Retried",
  display: true,
  timestamp: 0,
};

describe("waiting for a usage limit to reset", () => {
  test("omits the failed attempt and shows when Pi will continue", () => {
    const pi = harness();

    const result = failOnUsageLimit(pi);

    expect(result).toStrictEqual({
      entries: [{ type: "context_edit", targetId: "a1", replacement: null }],
    });
    expect(pi.notifications).toStrictEqual([
      {
        message: "Usage limit reached. Pi will continue at t+90m; `/retry off` cancels.",
        level: "warning",
      },
    ]);
    expect(pi.widgetText(RETRY_TYPE)).toBe(
      "⏸ Usage limit reached · retry at t+90m · /retry off to cancel",
    );
    expect(pi.timerCount()).toBe(1);
  });

  test("starts the next turn once the wall clock passes the reset", () => {
    const pi = harness();
    failOnUsageLimit(pi);

    pi.advanceTo(RESETS_AT - 1);
    expect(pi.sent).toStrictEqual([]);

    pi.advanceTo(RESETS_AT + 10 * MINUTE);
    expect(pi.sent).toStrictEqual([
      {
        message: {
          customType: RETRY_TYPE,
          content: "Retried after the usage limit reset at t+90m",
          display: true,
        },
        options: { triggerTurn: true },
      },
    ]);
    expect(pi.widgetText(RETRY_TYPE)).toBeUndefined();
    expect(pi.timerCount()).toBe(0);
  });

  test("waits for Pi to be idle before resuming", () => {
    const pi = harness();
    failOnUsageLimit(pi);
    pi.setIdle(false);

    pi.advanceTo(RESETS_AT);
    expect(pi.sent).toHaveLength(0);

    pi.setIdle(true);
    pi.advanceTo(RESETS_AT + MINUTE);
    expect(pi.sent).toHaveLength(1);
  });

  test("accepts a reset exactly at the five-hour cap", () => {
    const pi = harness();

    expect(failOnUsageLimit(pi, { resetsAt: MAX_WAIT_MS })).toBeDefined();
  });
});

describe("leaving the failure to the user", () => {
  test.each([
    ["the notice has no reset time", { provider: "claude" }],
    ["the notice is not an object", null],
    ["the published notice is malformed", { resetsAt: "soon" }],
    ["the reset is more than five hours away", { resetsAt: MAX_WAIT_MS + 1 }],
    ["the reset has already passed", { resetsAt: 0 }],
  ])("does nothing when %s", (_case, notice) => {
    const pi = harness();

    expect(failOnUsageLimit(pi, notice)).toBeUndefined();
    expect(pi.notifications).toStrictEqual([]);
    expect(pi.timerCount()).toBe(0);
  });

  test("a nested tool-call limit does not contaminate the next main reply", () => {
    const pi = harness();
    pi.startRun();
    pi.publish(USAGE_LIMIT_CHANNEL, NOTICE);
    pi.startTurn();
    expect(
      pi.settle("error", [
        assistantEntry("tools", "toolUse"),
        assistantEntry("connection-error", "error"),
      ]),
    ).toBeUndefined();
    expect(pi.timerCount()).toBe(0);
    expect(pi.notifications).toStrictEqual([]);
  });

  test.each([
    ["the old Claude provider id", "claude-sdk"],
    ["the new Claude provider id", "claude"],
  ])("a notice under %s matches a failure from the Claude provider", (_case, provider) => {
    const pi = harness();
    expect(failOnUsageLimit(pi, { provider, resetsAt: RESETS_AT })).toBeDefined();
  });

  test("a Claude notice matches a failure saved under the old provider id", () => {
    const pi = harness();
    const failed = assistantEntry("a1", "error", undefined, "claude-sdk");
    pi.startRun();
    pi.publish(USAGE_LIMIT_CHANNEL, NOTICE);
    expect(pi.settle("error", [userEntry("u1"), failed])).toBeDefined();
  });

  test("a retry cannot reuse the failed request's notice", () => {
    const pi = harness();
    pi.startRun();
    pi.publish(USAGE_LIMIT_CHANNEL, NOTICE);
    pi.startRun();
    expect(pi.settle("error", [assistantEntry("retry-error", "error")])).toBeUndefined();
    expect(pi.timerCount()).toBe(0);
    expect(pi.notifications).toStrictEqual([]);
  });

  test("consumes a notice only once", () => {
    const pi = harness();
    failOnUsageLimit(pi);
    expect(pi.settle("error", [assistantEntry("other-error", "error")])).toBeUndefined();
    expect(pi.timerCount()).toBe(1);
  });

  test.each([
    ["completed", "after a reply", [assistantEntry("a1", "stop")]],
    ["aborted", "after an aborted reply", [assistantEntry("a1", "aborted")]],
    ["error", "on a user entry", [userEntry("u1")]],
    ["error", "on a user entry after a reply", [assistantEntry("a1", "stop"), userEntry("u2")]],
    [
      "error",
      "on a user entry after a failed reply",
      [assistantEntry("a1", "error"), userEntry("u2")],
    ],
  ] as const)("does nothing when the run ended %s %s", (outcome, _ending, entries) => {
    const pi = harness();
    pi.startRun();
    pi.publish(USAGE_LIMIT_CHANNEL, { resetsAt: RESETS_AT });

    expect(pi.settle(outcome, [...entries])).toBeUndefined();
    expect(pi.timerCount()).toBe(0);
  });
});

describe("cancelling a scheduled resume", () => {
  test("a new prompt takes over", () => {
    const pi = harness();
    failOnUsageLimit(pi);

    expect(pi.input("interactive")).toStrictEqual({ action: "continue" });

    expect(pi.notifications.at(-1)).toStrictEqual({
      message: "Retry cancelled: your new prompt takes over.",
      level: "info",
    });
    expect(pi.widgetText(RETRY_TYPE)).toBeUndefined();
    pi.advanceTo(RESETS_AT);
    expect(pi.sent).toStrictEqual([]);
  });

  test("input with nothing scheduled is passed through silently", () => {
    const pi = harness();

    expect(pi.input("rpc")).toStrictEqual({ action: "continue" });
    expect(pi.notifications).toStrictEqual([]);
  });

  test("a turn started by another extension cancels the old wait", () => {
    const pi = harness();
    failOnUsageLimit(pi);
    pi.input("extension");
    pi.startRun();
    expect(pi.timerCount()).toBe(0);
    expect(pi.widgetText(RETRY_TYPE)).toBeUndefined();
    pi.advanceTo(RESETS_AT);
    expect(pi.sent).toStrictEqual([]);
    failOnUsageLimit(pi, { resetsAt: RESETS_AT + MINUTE });
    expect(pi.timerCount()).toBe(1);
    pi.advanceTo(RESETS_AT + MINUTE);
    expect(pi.sent).toHaveLength(1);
    expect(pi.timerCount()).toBe(0);
  });

  test("tree navigation cancels the wait and any unconsumed notice", () => {
    const pi = harness();
    failOnUsageLimit(pi);
    pi.publish(USAGE_LIMIT_CHANNEL, NOTICE);
    pi.navigateTree();
    expect(pi.timerCount()).toBe(0);
    expect(pi.widgetText(RETRY_TYPE)).toBeUndefined();
    expect(pi.settle("error", [assistantEntry("old-error", "error")])).toBeUndefined();
    pi.advanceTo(RESETS_AT);
    expect(pi.sent).toStrictEqual([]);
  });
});

describe("/retry", () => {
  test("off cancels a scheduled resume and stops later ones", async () => {
    const pi = harness();
    failOnUsageLimit(pi);

    await pi.command("off");

    expect(pi.timerCount()).toBe(0);
    expect(pi.widgetText(RETRY_TYPE)).toBeUndefined();
    expect(pi.notifications.at(-1)?.message).toBe("Retry is off for this session.");
    expect(failOnUsageLimit(pi)).toBeUndefined();
  });

  test("on re-enables it, and no argument toggles", async () => {
    const pi = harness();

    await pi.command("off");
    await pi.command("on");
    expect(failOnUsageLimit(pi)).toBeDefined();

    await pi.command("");
    expect(pi.notifications.at(-1)?.message).toBe("Retry is off for this session.");
    await pi.command("  ");
    expect(pi.notifications.at(-1)?.message).toBe("Retry is on for this session.");
  });

  test("rejects other arguments", async () => {
    const pi = harness();

    await pi.command("later");

    expect(pi.notifications).toStrictEqual([
      { message: "Usage: /retry [on|off]", level: "warning" },
    ]);
  });
});

describe("keeping /retry off for the whole session", () => {
  test("stays off when the saved session file is reopened", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-retry-session-"));

    try {
      const session = SessionManager.create(dir, dir);
      say(session, "first");
      const original = open(session);
      await original.command("off");
      original.shutdown();
      const reopened = open(SessionManager.open(savedFile(session)), "resume");

      expect(failOnUsageLimit(reopened)).toBeUndefined();
      expect(reopened.timerCount()).toBe(0);
      reopened.advanceTo(RESETS_AT);
      expect(reopened.sent).toStrictEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stays off after a reload re-registers the extension", async () => {
    const session = SessionManager.inMemory();
    const original = open(session);
    await original.command("off");
    original.shutdown();

    const reloaded = open(session, "reload");

    expect(failOnUsageLimit(reloaded)).toBeUndefined();
    expect(reloaded.timerCount()).toBe(0);
  });

  test("turning it back on is restored too", async () => {
    const session = SessionManager.inMemory();
    const original = open(session);
    await original.command("off");
    await original.command("on");

    expect(failOnUsageLimit(open(session, "reload"))).toBeDefined();
  });

  test.each([
    ["the default visible row before the off command", (_first: string, second: string) => second],
    ["an earlier message before the off command", (first: string) => first],
  ])("stays off after /tree moves to %s", async (_label, pick) => {
    const session = SessionManager.inMemory();
    const target = pick(say(session, "first"), say(session, "second"));
    const pi = open(session);
    await pi.command("off");

    session.branch(target);
    pi.navigateTree();

    expect(failOnUsageLimit(pi)).toBeUndefined();
    expect(failOnUsageLimit(open(session, "resume"))).toBeUndefined();
  });

  test("a new session starts on", async () => {
    const session = SessionManager.inMemory();
    const pi = open(session);
    await pi.command("off");
    pi.shutdown();
    session.newSession();

    expect(failOnUsageLimit(open(session, "new"))).toBeDefined();
  });

  test("a fork or clone starts on although it copies the off record", async () => {
    const session = SessionManager.inMemory();
    say(session, "first");
    const pi = open(session);
    await pi.command("off");
    const leaf = say(session, "after");
    const parentId = session.getSessionId();
    pi.shutdown();

    session.createBranchedSession(leaf);

    expect(session.getSessionId()).not.toBe(parentId);
    expect(session.getEntries().some((entry) => entry.type === "custom")).toBe(true);
    expect(failOnUsageLimit(open(session, "fork"))).toBeDefined();
  });

  test("uses the newest valid record for this session and ignores the rest", () => {
    const session = SessionManager.inMemory();
    const sessionId = session.getSessionId();
    session.appendCustomEntry(SETTING_TYPE, { version: 1, enabled: false, sessionId });

    for (const data of [
      { version: 2, enabled: true, sessionId },
      { version: 1, enabled: "on", sessionId },
      { version: 1, enabled: true, sessionId: "another-session" },
      { version: 1, enabled: true },
      null,
      "on",
    ]) {
      session.appendCustomEntry(SETTING_TYPE, data);
    }

    session.appendCustomEntry("other-extension", { version: 1, enabled: true, sessionId });

    expect(failOnUsageLimit(open(session))).toBeUndefined();
  });

  test("a session with only invalid records starts on", () => {
    const session = SessionManager.inMemory();
    session.appendCustomEntry(SETTING_TYPE, { version: 2, enabled: false });
    session.appendCustomEntry(SETTING_TYPE, {
      version: 1,
      enabled: false,
      sessionId: "another-session",
    });

    expect(failOnUsageLimit(open(session))).toBeDefined();
  });

  test("saves a versioned record tagged with the session", async () => {
    const session = SessionManager.inMemory();
    const pi = open(session);
    await pi.command("off");

    expect(pi.appended).toStrictEqual([
      {
        customType: SETTING_TYPE,
        data: { version: 1, enabled: false, sessionId: session.getSessionId() },
      },
    ]);
    expect(pi.notifications.at(-1)?.message).toBe("Retry is off for this session.");
  });

  test("a failed save still cancels the pending wait and says it was not saved", async () => {
    const pi = harness();
    const writes: Array<unknown> = [];
    pi.pi.appendEntry = (_customType, data) => {
      writes.push(data);
      throw new Error("synthetic full disk");
    };
    failOnUsageLimit(pi);
    expect(pi.timerCount()).toBe(1);

    await pi.command("off");

    expect(writes).toHaveLength(1);
    expect(pi.timerCount()).toBe(0);
    pi.advanceTo(RESETS_AT + 10 * MINUTE);
    expect(pi.sent).toStrictEqual([]);
    expect(pi.notifications.at(-1)).toStrictEqual({
      message:
        "Retry is off for this session. Saving it failed, so it lasts only until this session is reloaded or reopened.",
      level: "info",
    });
    expect(failOnUsageLimit(pi)).toBeUndefined();
  });

  test("the wait is cancelled before the save is attempted", async () => {
    const pi = harness();
    const timersAtSave: Array<number> = [];
    pi.pi.appendEntry = () => {
      timersAtSave.push(pi.timerCount());
    };
    failOnUsageLimit(pi);

    await pi.command("off");

    expect(timersAtSave).toStrictEqual([0]);
  });
});

describe("the resume marker", () => {
  test("is hidden from the model", () => {
    const pi = harness();
    const user: AgentMessage = { role: "user", content: "go", timestamp: 0 };

    expect(pi.context([user, marker])).toStrictEqual({ messages: [user] });
    expect(pi.context([user])).toBeUndefined();
  });

  test("hides markers saved under the old type from the model", () => {
    const pi = harness();
    const user: AgentMessage = { role: "user", content: "go", timestamp: 0 };
    const legacy: AgentMessage = { ...marker, customType: LEGACY_RETRY_TYPE };

    expect(LEGACY_RETRY_TYPE).toBe("auto-resume");
    expect(pi.context([user, legacy, marker])).toStrictEqual({ messages: [user] });
  });

  test("keeps other custom messages in context", () => {
    const pi = harness();
    const other: AgentMessage = { ...marker, customType: "other" };

    expect(pi.context([other])).toBeUndefined();
  });

  test("renders as a dim transcript line", () => {
    const pi = harness();

    expect(pi.renderMarker("Retried after the usage limit reset at t+90m")).toBe(
      "↻ Retried after the usage limit reset at t+90m",
    );
    expect(pi.renderMarker([{ type: "text", text: "x" }])).toBe("↻");
  });

  test.each([RETRY_TYPE, LEGACY_RETRY_TYPE])("renders markers of type %s", (customType) => {
    const pi = harness();

    expect(pi.renderMarker("Auto-resumed after the usage limit reset at t+90m", customType)).toBe(
      "↻ Auto-resumed after the usage limit reset at t+90m",
    );
  });
});

describe("print and JSON modes", () => {
  test("JSON mode records the reset as a session entry", () => {
    const pi = harness("json");

    expect(failOnUsageLimit(pi, { resetsAt: MAX_WAIT_MS * 2 })).toBeUndefined();

    expect(pi.appended).toStrictEqual([
      { customType: RETRY_TYPE, data: { resetsAt: MAX_WAIT_MS * 2 } },
    ]);
    expect(pi.stderr).toStrictEqual([]);
  });
});

describe("malformed reset dates", () => {
  test.each(["print", "json"] as const)("rejects invalid dates in %s mode", (mode) => {
    const pi = harness(mode);

    for (const resetsAt of [
      Number.NaN,
      Infinity,
      -Infinity,
      8.64e15 + 1,
      -8.64e15 - 1,
      Number.MAX_VALUE,
    ]) {
      expect(failOnUsageLimit(pi, { resetsAt })).toBeUndefined();
    }

    expect(pi.timerCount()).toBe(0);
    expect(pi.notifications).toStrictEqual([]);
    expect(pi.stderr).toStrictEqual([]);
    expect(pi.appended).toStrictEqual([]);
  });
});
