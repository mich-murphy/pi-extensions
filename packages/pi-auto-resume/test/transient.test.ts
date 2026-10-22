import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
  AUTO_RESUME_TYPE,
  CHECK_INTERVAL_MS,
  DEFAULT_TRANSIENT_SETTINGS,
  readTransientSettings,
  registerAutoResume,
  USAGE_LIMIT_CHANNEL,
} from "../auto-resume";
import { assistantEntry, fakePi, userEntry } from "./fake-pi";

const MINUTE = CHECK_INTERVAL_MS;
const CONNECTION_ERROR = "Connection error.";

function harness(mode: ExtensionContext["mode"] = "tui", settings: object = {}) {
  const pi = fakePi(mode, settings);
  registerAutoResume(pi.pi, pi.deps);
  return pi;
}

function fail(pi: ReturnType<typeof harness>, errorMessage = CONNECTION_ERROR, id = "a1") {
  pi.startRun();
  return pi.settle("error", [userEntry("u1"), assistantEntry(id, "error", errorMessage)]);
}

function failAndResume(pi: ReturnType<typeof harness>, clock: { now: number }): number | undefined {
  const sentBefore = pi.sent.length;
  if (fail(pi) === undefined) {
    return undefined;
  }
  for (let minute = 1; minute <= 60; minute += 1) {
    pi.advanceTo(clock.now + minute * MINUTE);
    if (pi.sent.length > sentBefore) {
      clock.now += minute * MINUTE;
      return minute;
    }
  }
  throw new Error("wait never resumed");
}

describe("classifying a failed reply", () => {
  test.each([
    CONNECTION_ERROR,
    "terminated",
    "OAuth refresh failed for openai: fetch failed",
    "Claude Agent SDK: the query failed; retry or check Claude Code status",
    "Our servers are currently overloaded. Please try again later.",
    "OpenAI Responses stream ended before a terminal response event",
    "Claude Agent SDK: could not start the query (unexpected SDK error)",
  ])("resumes after %s", (errorMessage) => {
    const pi = harness();

    expect(fail(pi, errorMessage)).toBeDefined();
    expect(pi.timerCount()).toBe(1);
  });

  test.each([
    "prompt is too long: 213000 tokens > 200000 maximum",
    "401 Unauthorized: invalid x-api-key",
    "400 invalid_request_error: messages: field required",
    "Something unexpected happened",
  ])("leaves %s to the user", (errorMessage) => {
    const pi = harness();

    expect(fail(pi, errorMessage)).toBeUndefined();
    expect(pi.timerCount()).toBe(0);
    expect(pi.notifications).toStrictEqual([]);
  });

  test("an aborted run does not resume", () => {
    const pi = harness();
    pi.startRun();

    expect(
      pi.settle("aborted", [assistantEntry("a1", "aborted", CONNECTION_ERROR)]),
    ).toBeUndefined();
    expect(pi.timerCount()).toBe(0);
    expect(pi.notifications).toStrictEqual([]);
  });

  test("an error run whose last entry is not a failed reply does not resume", () => {
    const pi = harness();
    pi.startRun();

    expect(pi.settle("error", [assistantEntry("a1", "stop", CONNECTION_ERROR)])).toBeUndefined();
    expect(pi.timerCount()).toBe(0);
  });

  test.each(["print", "json"] as const)("%s mode never schedules", (mode) => {
    const pi = harness(mode);

    expect(fail(pi)).toBeUndefined();
    expect(pi.timerCount()).toBe(0);
    expect(pi.stderr).toStrictEqual([]);
    expect(pi.appended).toStrictEqual([]);
  });

  test("RPC mode schedules", () => {
    expect(fail(harness("rpc"))).toBeDefined();
  });
});

describe("retrying a transient failure", () => {
  test("omits the failed attempt, shows the retry, and resumes after the delay", () => {
    const pi = harness();

    expect(fail(pi)).toStrictEqual({
      entries: [{ type: "context_edit", targetId: "a1", replacement: null }],
    });
    expect(pi.notifications).toStrictEqual([
      {
        message: "Provider error. Pi will retry automatically at t+1m (attempt 1).",
        level: "warning",
      },
    ]);
    expect(pi.widgetText(AUTO_RESUME_TYPE)).toBe(
      "⏸ Provider error · attempt 1 · auto-resume at t+1m · /auto-resume off to cancel",
    );

    pi.advanceTo(MINUTE - 1);
    expect(pi.sent).toStrictEqual([]);
    pi.advanceTo(MINUTE);
    expect(pi.sent).toStrictEqual([
      {
        message: {
          customType: AUTO_RESUME_TYPE,
          content: "Auto-resumed after a transient provider error (attempt 1)",
          display: true,
        },
        options: { triggerTurn: true },
      },
    ]);
    expect(pi.timerCount()).toBe(0);
    expect(pi.widgetText(AUTO_RESUME_TYPE)).toBeUndefined();
  });

  test("never resumes the same stop twice", () => {
    const pi = harness();
    fail(pi);

    pi.advanceTo(MINUTE);
    pi.advanceTo(2 * MINUTE);
    pi.advanceTo(30 * MINUTE);

    expect(pi.sent).toHaveLength(1);
  });

  test("backs off 1, 2, 5, 10, 15, 15 minutes and stops at the two-hour window", () => {
    const pi = harness();
    const clock = { now: 0 };

    const delays = Array.from({ length: 8 }, () => failAndResume(pi, clock));

    expect(delays).toStrictEqual([1, 2, 5, 10, 15, 15, 15, 15]);
    expect(fail(pi)).toBeUndefined();
    expect(pi.notifications.at(-1)).toStrictEqual({
      message: "Provider error persists after 8 automatic retries. Send a message to continue.",
      level: "warning",
    });
    expect(pi.timerCount()).toBe(0);
  });

  test("the window caps attempts before the attempt limit", () => {
    const pi = harness("tui", { autoResume: { transient: { windowMinutes: 10 } } });
    const clock = { now: 0 };

    expect([
      failAndResume(pi, clock),
      failAndResume(pi, clock),
      failAndResume(pi, clock),
    ]).toStrictEqual([1, 2, 5]);
    expect(fail(pi)).toBeUndefined();
    expect(pi.notifications.at(-1)?.message).toBe(
      "Provider error persists after 3 automatic retries. Send a message to continue.",
    );
    expect(pi.timerCount()).toBe(0);
  });

  test("warns once at the cap, then starts a fresh streak", () => {
    const pi = harness("tui", { autoResume: { transient: { maxAttempts: 1 } } });
    const clock = { now: 0 };
    failAndResume(pi, clock);

    expect(fail(pi)).toBeUndefined();
    const warnings = pi.notifications.filter(({ message }) => message.includes("persists"));
    expect(warnings).toHaveLength(1);
    expect(fail(pi)).toBeDefined();
  });

  test("a completed run resets the backoff", () => {
    const pi = harness();
    const clock = { now: 0 };
    failAndResume(pi, clock);
    failAndResume(pi, clock);
    pi.startRun();
    pi.settle("completed", [assistantEntry("ok", "stop")]);

    expect(failAndResume(pi, clock)).toBe(1);
  });

  test("a user prompt resets the backoff", () => {
    const pi = harness();
    const clock = { now: 0 };
    failAndResume(pi, clock);
    failAndResume(pi, clock);
    pi.input("interactive");

    expect(failAndResume(pi, clock)).toBe(1);
  });

  test("extension input keeps the backoff", () => {
    const pi = harness();
    const clock = { now: 0 };
    failAndResume(pi, clock);
    pi.input("extension");

    expect(failAndResume(pi, clock)).toBe(2);
  });

  test("an aborted run keeps the backoff without resuming", () => {
    const pi = harness();
    const clock = { now: 0 };
    failAndResume(pi, clock);
    pi.startRun();
    pi.settle("aborted", [assistantEntry("x", "aborted")]);

    expect(failAndResume(pi, clock)).toBe(2);
  });
});

describe("cancelling and superseding a transient wait", () => {
  test("a new prompt cancels it", () => {
    const pi = harness();
    fail(pi);

    pi.input("interactive");

    expect(pi.timerCount()).toBe(0);
    pi.advanceTo(10 * MINUTE);
    expect(pi.sent).toStrictEqual([]);
  });

  test.each([
    [
      "agent start",
      (pi: ReturnType<typeof harness>) => {
        pi.startRun();
      },
    ],
    [
      "tree navigation",
      (pi: ReturnType<typeof harness>) => {
        pi.navigateTree();
      },
    ],
    [
      "shutdown",
      (pi: ReturnType<typeof harness>) => {
        pi.shutdown();
      },
    ],
    [
      "/auto-resume off",
      (pi: ReturnType<typeof harness>) => {
        void pi.command("off");
      },
    ],
  ])("%s cancels it", (_case, act) => {
    const pi = harness();
    fail(pi);

    act(pi);

    expect(pi.timerCount()).toBe(0);
    expect(pi.widgetText(AUTO_RESUME_TYPE)).toBeUndefined();
    pi.advanceTo(10 * MINUTE);
    expect(pi.sent).toStrictEqual([]);
  });

  test("/auto-resume off stops later transient waits", async () => {
    const pi = harness();

    await pi.command("off");

    expect(fail(pi)).toBeUndefined();
    expect(pi.timerCount()).toBe(0);
  });

  test("a usage-limit notice supersedes a pending transient wait", () => {
    const pi = harness();
    fail(pi);

    pi.startRun();
    pi.publish(USAGE_LIMIT_CHANNEL, { provider: "claude-sdk", resetsAt: 90 * MINUTE });
    pi.settle("error", [assistantEntry("a2", "error", CONNECTION_ERROR)]);

    expect(pi.timerCount()).toBe(1);
    expect(pi.widgetText(AUTO_RESUME_TYPE)).toContain("Usage limit reached");
    pi.advanceTo(10 * MINUTE);
    expect(pi.sent).toStrictEqual([]);
    pi.advanceTo(90 * MINUTE);
    expect(pi.sent).toHaveLength(1);
  });

  test("a usage-limit notice from another provider never falls back to a transient retry", () => {
    const pi = harness();
    pi.startRun();
    pi.publish(USAGE_LIMIT_CHANNEL, { provider: "other", resetsAt: 90 * MINUTE });

    expect(pi.settle("error", [assistantEntry("a1", "error", CONNECTION_ERROR)])).toBeUndefined();
    expect(pi.timerCount()).toBe(0);
  });
});

describe("autoResume.transient settings", () => {
  test("defaults apply when the key is absent", () => {
    expect(readTransientSettings({})).toStrictEqual(DEFAULT_TRANSIENT_SETTINGS);
    expect(readTransientSettings({ autoResume: {} })).toStrictEqual(DEFAULT_TRANSIENT_SETTINGS);
  });

  test("partial settings fill in from the defaults and allow fractional minutes", () => {
    expect(
      readTransientSettings({
        autoResume: { transient: { delaysMinutes: [0.05], maxAttempts: 2 } },
      }),
    ).toStrictEqual({ ...DEFAULT_TRANSIENT_SETTINGS, delaysMinutes: [0.05], maxAttempts: 2 });
  });

  test.each([
    ["autoResume is not an object", { autoResume: true }],
    ["transient is not an object", { autoResume: { transient: [] } }],
    ["enabled is not a boolean", { autoResume: { transient: { enabled: "yes" } } }],
    ["delays are empty", { autoResume: { transient: { delaysMinutes: [] } } }],
    ["a delay is not positive", { autoResume: { transient: { delaysMinutes: [1, 0] } } }],
    ["maxAttempts is fractional", { autoResume: { transient: { maxAttempts: 1.5 } } }],
    ["windowMinutes is negative", { autoResume: { transient: { windowMinutes: -1 } } }],
  ])("rejects settings when %s", (_case, settings) => {
    expect(readTransientSettings(settings)).toBeUndefined();
  });

  test("invalid settings warn once and fall back to the defaults", () => {
    const pi = harness("tui", { autoResume: { transient: { maxAttempts: 0 } } });

    expect(fail(pi)).toBeDefined();
    pi.input("interactive");
    fail(pi);

    expect(
      pi.notifications.filter(({ message }) => message.startsWith("Invalid autoResume")),
    ).toStrictEqual([
      { message: "Invalid autoResume.transient settings; using the defaults.", level: "warning" },
    ]);
    expect(pi.widgetText(AUTO_RESUME_TYPE)).toContain("t+1m");
  });

  test("enabled false turns off transient retries but not usage-limit resumes", () => {
    const pi = harness("tui", { autoResume: { transient: { enabled: false } } });

    expect(fail(pi)).toBeUndefined();
    pi.startRun();
    pi.publish(USAGE_LIMIT_CHANNEL, { resetsAt: 90 * MINUTE });
    expect(pi.settle("error", [assistantEntry("a2", "error")])).toBeDefined();
  });

  test("settings are reread at each failure", () => {
    const pi = harness();
    pi.setSettings({ autoResume: { transient: { delaysMinutes: [3] } } });

    fail(pi);

    expect(pi.widgetText(AUTO_RESUME_TYPE)).toContain("t+3m");
  });
});
