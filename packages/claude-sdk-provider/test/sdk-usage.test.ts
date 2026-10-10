import { Effect } from "effect";
import { describe, expect, test, vi } from "vitest";
import { formatClaudeUsageStatus, inspectClaudeUsage } from "../sdk-usage";
import type { ClaudeUsageQuery, StartClaudeUsageQuery } from "../sdk-usage";
import { unsettled } from "./fixtures";

const failureOf = async (start: StartClaudeUsageQuery, timeout?: number) =>
  Effect.runPromise(Effect.flip(inspectClaudeUsage(start, timeout)));

function usageQuery(response: unknown): ClaudeUsageQuery {
  return {
    readUsage: async () => response,
    close: async () => undefined,
  };
}

const usageResponse = {
  subscription_type: "team",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 12, resets_at: "2026-08-31T14:50:00.000Z" },
    seven_day: { utilization: 29, resets_at: "2026-09-02T09:00:00.000Z" },
    model_scoped: [{ display_name: "Fable", utilization: 49, resets_at: null }],
    extra_usage: {
      is_enabled: false,
      monthly_limit: null,
      used_credits: null,
      utilization: null,
      currency: "AUD",
    },
  },
};

describe("claude SDK usage", () => {
  test("reports remaining general and model-specific plan usage", async () => {
    const status = await Effect.runPromise(inspectClaudeUsage(() => usageQuery(usageResponse)));

    expect(status).toStrictEqual({
      subscriptionType: "team",
      rateLimitsAvailable: true,
      windows: [
        { name: "Current session", usedPercent: 12, resetsAt: "2026-08-31T14:50:00.000Z" },
        { name: "Weekly", usedPercent: 29, resetsAt: "2026-09-02T09:00:00.000Z" },
        { name: "Fable weekly", usedPercent: 49, resetsAt: null },
      ],
      extraUsageEnabled: false,
    });
    const formatted = formatClaudeUsageStatus(status);
    expect(formatted).toContain("Current session: 88% remaining");
    expect(formatted).toContain("Weekly: 71% remaining");
    expect(formatted).toContain("Fable weekly: 51% remaining");
    expect(formatted).toContain("Extra usage: disabled");
  });

  test("reports unavailable plan limits without inventing usage", async () => {
    const status = await Effect.runPromise(
      inspectClaudeUsage(() =>
        usageQuery({ subscription_type: null, rate_limits_available: false, rate_limits: null }),
      ),
    );

    expect(formatClaudeUsageStatus(status)).toBe(
      "Claude plan usage is unavailable for the current authentication method.",
    );
  });

  test("rejects malformed experimental SDK responses", async () => {
    const error = await failureOf(() =>
      usageQuery({
        subscription_type: "team",
        rate_limits_available: true,
        rate_limits: { five_hour: {} },
      }),
    );

    expect(error).toMatchObject({ _tag: "ClaudeUsageInspectionError", operation: "parse" });
    expect(error.message).toBe("Claude returned usage data in an unexpected format");
  });

  test("classifies startup, read, and cleanup failures with specific messages", async () => {
    const startup = await failureOf(() => {
      throw new Error("spawn failed");
    });
    const read = await failureOf(() => ({
      readUsage: async () => {
        throw new Error("request failed");
      },
      close: async () => undefined,
    }));
    const close = await failureOf(() => ({
      readUsage: async () => usageResponse,
      close: async () => {
        throw new Error("close failed");
      },
    }));

    expect(startup).toMatchObject({ operation: "start" });
    expect(startup.message).toBe("Could not start a Claude session to read usage");
    expect(read).toMatchObject({ operation: "read" });
    expect(read.message).toBe("Claude did not return usage data");
    expect(close).toMatchObject({ operation: "close" });
    expect(close.message).toBe("Could not close the Claude usage session");
  });

  test("reports a read failure rather than a cleanup failure when both fail", async () => {
    const error = await failureOf(() => ({
      readUsage: async () => {
        throw new Error("request failed");
      },
      close: async () => {
        throw new Error("close failed");
      },
    }));

    expect(error).toMatchObject({ operation: "read" });
  });

  test("times out a usage request that never responds", async () => {
    const error = await failureOf(
      () => ({
        readUsage: async () => unsettled(),
        close: async () => undefined,
      }),
      1,
    );

    expect(error._tag).toBe("ClaudeUsageTimeoutError");
    expect(error.message).toBe("Timed out after 1ms waiting for Claude usage");
  });

  test("bounds cleanup after both a successful read and a read timeout", async () => {
    vi.useFakeTimers();
    try {
      const successfulRead = failureOf(
        () => ({
          readUsage: async () => usageResponse,
          close: async () => unsettled(),
        }),
        10,
      );
      const timedOutRead = failureOf(
        () => ({
          readUsage: async () => unsettled(),
          close: async () => unsettled(),
        }),
        10,
      );

      await vi.runAllTimersAsync();
      const [cleanupError, readError] = await Promise.all([successfulRead, timedOutRead]);

      expect(cleanupError).toMatchObject({ operation: "close" });
      expect(readError._tag).toBe("ClaudeUsageTimeoutError");
    } finally {
      vi.useRealTimers();
    }
  });

  test("aborts the idle SDK query after reading usage", async () => {
    let observedSignal: AbortSignal | undefined;
    const start: StartClaudeUsageQuery = (abortController) => {
      observedSignal = abortController.signal;
      return usageQuery(usageResponse);
    };

    await Effect.runPromise(inspectClaudeUsage(start));

    expect(observedSignal?.aborted).toBe(true);
  });
});
