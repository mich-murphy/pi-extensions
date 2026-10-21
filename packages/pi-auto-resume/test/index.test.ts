import { afterEach, describe, expect, test, vi } from "vitest";
import { CHECK_INTERVAL_MS, USAGE_LIMIT_CHANNEL } from "../auto-resume";
import autoResume from "../index";
import { assistantEntry, fakePi } from "./fake-pi";

describe("extension factory", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("resumes on the real clock once the reset passes", () => {
    vi.useFakeTimers({ now: 0 });
    const pi = fakePi();
    autoResume(pi.pi);
    pi.startRun();
    pi.publish(USAGE_LIMIT_CHANNEL, { resetsAt: 2 * CHECK_INTERVAL_MS });
    pi.settle("error", [assistantEntry("a1", "error")]);

    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    expect(pi.sent).toHaveLength(0);
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    expect(pi.sent).toHaveLength(1);

    vi.advanceTimersByTime(CHECK_INTERVAL_MS * 10);
    expect(pi.sent).toHaveLength(1);
  });

  test("tears down real intervals on tree navigation and shutdown", () => {
    vi.useFakeTimers({ now: 0 });
    const pi = fakePi();
    autoResume(pi.pi);
    const schedule = () => {
      pi.startRun();
      pi.publish(USAGE_LIMIT_CHANNEL, { resetsAt: 2 * CHECK_INTERVAL_MS });
      pi.settle("error", [assistantEntry("a1", "error")]);
      expect(vi.getTimerCount()).toBe(1);
    };
    schedule();
    pi.navigateTree();
    expect(vi.getTimerCount()).toBe(0);
    schedule();
    pi.shutdown();
    pi.shutdown();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * CHECK_INTERVAL_MS);
    expect(pi.sent).toHaveLength(0);
  });

  test("prints the reset time on stderr in print mode", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const pi = fakePi("print");
    autoResume(pi.pi);
    pi.startRun();
    pi.publish(USAGE_LIMIT_CHANNEL, { resetsAt: 0 });
    pi.settle("error", [assistantEntry("a1", "error")]);

    expect(write).toHaveBeenCalledWith("Usage limit resets at 1970-01-01T00:00:00.000Z\n");
  });
});
