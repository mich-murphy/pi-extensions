import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
  AUTO_RESUME_TYPE,
  CHECK_INTERVAL_MS,
  MAX_WAIT_MS,
  registerAutoResume,
  USAGE_LIMIT_CHANNEL,
} from "../auto-resume";
import { assistantEntry, fakePi, userEntry } from "./fake-pi";

const MINUTE = CHECK_INTERVAL_MS;
const RESETS_AT = 90 * MINUTE;
const NOTICE = { provider: "claude-sdk", resetsAt: RESETS_AT };

function harness(mode: ExtensionContext["mode"] = "tui") {
  const pi = fakePi(mode);
  registerAutoResume(pi.pi, pi.deps);
  return pi;
}

/** Run one turn that fails on a usage limit after the provider published `resetsAt`. */
function failOnUsageLimit(pi: ReturnType<typeof harness>, notice: unknown = NOTICE) {
  pi.startRun();
  pi.publish(USAGE_LIMIT_CHANNEL, notice);
  return pi.settle("error", [userEntry("u1"), assistantEntry("a1", "error")]);
}

const marker: AgentMessage = {
  role: "custom",
  customType: AUTO_RESUME_TYPE,
  content: "Auto-resumed",
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
        message: "Usage limit reached. Pi will continue automatically at t+90m.",
        level: "warning",
      },
    ]);
    expect(pi.widgetText(AUTO_RESUME_TYPE)).toBe(
      "⏸ Usage limit reached · auto-resume at t+90m · /auto-resume off to cancel",
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
          customType: AUTO_RESUME_TYPE,
          content: "Auto-resumed after the usage limit reset at t+90m",
          display: true,
        },
        options: { triggerTurn: true },
      },
    ]);
    expect(pi.widgetText(AUTO_RESUME_TYPE)).toBeUndefined();
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

  test("waits again when the resumed turn hits a new limit", () => {
    const pi = harness();
    failOnUsageLimit(pi);
    pi.advanceTo(RESETS_AT);

    const result = failOnUsageLimit(pi, { resetsAt: RESETS_AT + 30 * MINUTE });

    expect(result?.entries).toHaveLength(1);
    expect(pi.widgetText(AUTO_RESUME_TYPE)).toContain("t+120m");
  });

  test("accepts a reset exactly at the five-hour cap", () => {
    const pi = harness();

    expect(failOnUsageLimit(pi, { resetsAt: MAX_WAIT_MS })).toBeDefined();
  });
});

describe("leaving the failure to the user", () => {
  test.each([
    ["the notice has no reset time", { provider: "claude-sdk" }],
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
    // The first main response called a tool, which made a nested SDK request.
    pi.publish(USAGE_LIMIT_CHANNEL, NOTICE);
    // Pi starts the next main model/tool turn without another agent_start.
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

  test("a notice from another provider does not authorize omitting the failure", () => {
    const pi = harness();
    expect(failOnUsageLimit(pi, { provider: "other", resetsAt: RESETS_AT })).toBeUndefined();
    expect(pi.timerCount()).toBe(0);
  });

  test("a retry cannot reuse the failed request's notice", () => {
    const pi = harness();
    pi.startRun();
    pi.publish(USAGE_LIMIT_CHANNEL, NOTICE);
    // Pi retries before agent_before_settle; each retry emits agent_start.
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

  test("ignores a reset published in an earlier run", () => {
    const pi = harness();
    pi.publish(USAGE_LIMIT_CHANNEL, { resetsAt: RESETS_AT });
    pi.startRun();

    expect(pi.settle("error", [assistantEntry("a1", "error")])).toBeUndefined();
  });

  test.each([
    ["completed", [assistantEntry("a1", "stop")]],
    ["aborted", [assistantEntry("a1", "aborted")]],
    ["error", [userEntry("u1")]],
    ["error", [assistantEntry("a1", "stop"), userEntry("u2")]],
    ["error", [assistantEntry("a1", "error"), userEntry("u2")]],
  ] as const)("does nothing when the run ended %s without a failed reply", (outcome, entries) => {
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
      message: "Auto-resume cancelled: your new prompt takes over.",
      level: "info",
    });
    expect(pi.widgetText(AUTO_RESUME_TYPE)).toBeUndefined();
    pi.advanceTo(RESETS_AT);
    expect(pi.sent).toStrictEqual([]);
  });

  test("input from another extension leaves the resume in place", () => {
    const pi = harness();
    failOnUsageLimit(pi);

    pi.input("extension");

    expect(pi.timerCount()).toBe(1);
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
    expect(pi.widgetText(AUTO_RESUME_TYPE)).toBeUndefined();
    pi.advanceTo(RESETS_AT);
    expect(pi.sent).toStrictEqual([]);
    // A new usage failure gets precisely one fresh timer, not an orphan interval.
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
    expect(pi.widgetText(AUTO_RESUME_TYPE)).toBeUndefined();
    expect(pi.settle("error", [assistantEntry("old-error", "error")])).toBeUndefined();
    pi.advanceTo(RESETS_AT);
    expect(pi.sent).toStrictEqual([]);
  });

  test("session shutdown stops the timer", () => {
    const pi = harness();
    failOnUsageLimit(pi);

    pi.shutdown();
    pi.shutdown();

    expect(pi.timerCount()).toBe(0);
    expect(pi.widgetText(AUTO_RESUME_TYPE)).toBeUndefined();
    pi.advanceTo(RESETS_AT);
    expect(pi.sent).toStrictEqual([]);
  });
});

describe("/auto-resume", () => {
  test("off cancels a scheduled resume and stops later ones", async () => {
    const pi = harness();
    failOnUsageLimit(pi);

    await pi.command("off");

    expect(pi.timerCount()).toBe(0);
    expect(pi.widgetText(AUTO_RESUME_TYPE)).toBeUndefined();
    expect(pi.notifications.at(-1)?.message).toBe("Auto-resume is off for this session.");
    expect(failOnUsageLimit(pi)).toBeUndefined();
  });

  test("on re-enables it, and no argument toggles", async () => {
    const pi = harness();

    await pi.command("off");
    await pi.command("on");
    expect(failOnUsageLimit(pi)).toBeDefined();

    await pi.command("");
    expect(pi.notifications.at(-1)?.message).toBe("Auto-resume is off for this session.");
    await pi.command("  ");
    expect(pi.notifications.at(-1)?.message).toBe("Auto-resume is on for this session.");
  });

  test("rejects other arguments", async () => {
    const pi = harness();

    await pi.command("later");

    expect(pi.notifications).toStrictEqual([
      { message: "Usage: /auto-resume [on|off]", level: "warning" },
    ]);
  });

  test("completes on and off", async () => {
    const pi = harness();
    const command = await pi.command("on");

    await expect(Promise.resolve(command.getArgumentCompletions?.("o"))).resolves.toStrictEqual([
      { value: "on", label: "on" },
      { value: "off", label: "off" },
    ]);
    await expect(Promise.resolve(command.getArgumentCompletions?.("of"))).resolves.toStrictEqual([
      { value: "off", label: "off" },
    ]);
  });
});

describe("the resume marker", () => {
  test("is hidden from the model", () => {
    const pi = harness();
    const user: AgentMessage = { role: "user", content: "go", timestamp: 0 };

    expect(pi.context([user, marker])).toStrictEqual({ messages: [user] });
    expect(pi.context([user])).toBeUndefined();
  });

  test("renders as a dim transcript line", () => {
    const pi = harness();

    expect(pi.renderMarker("Auto-resumed after the usage limit reset at t+90m")).toBe(
      "↻ Auto-resumed after the usage limit reset at t+90m",
    );
    expect(pi.renderMarker([{ type: "text", text: "x" }])).toBe("↻");
  });
});

describe("print and JSON modes", () => {
  test("print mode reports the reset on stderr and never waits", () => {
    const pi = harness("print");

    expect(failOnUsageLimit(pi)).toBeUndefined();

    expect(pi.stderr).toStrictEqual([`Usage limit resets at ${new Date(RESETS_AT).toISOString()}`]);
    expect(pi.timerCount()).toBe(0);
  });

  test("JSON mode records the reset as a session entry", () => {
    const pi = harness("json");

    expect(failOnUsageLimit(pi, { resetsAt: MAX_WAIT_MS * 2 })).toBeUndefined();

    expect(pi.appended).toStrictEqual([
      { customType: AUTO_RESUME_TYPE, data: { resetsAt: MAX_WAIT_MS * 2 } },
    ]);
    expect(pi.stderr).toStrictEqual([]);
  });
});

describe("malformed reset dates", () => {
  test.each(["tui", "rpc", "print", "json"] as const)(
    "rejects invalid dates in %s mode",
    (mode) => {
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
    },
  );
});
