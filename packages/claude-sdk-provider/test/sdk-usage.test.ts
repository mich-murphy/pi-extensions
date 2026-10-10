import { assert, describe, expect, test, vi } from "vitest";
import { formatClaudeUsageStatus, inspectClaudeUsage } from "../sdk-usage";
import type { ClaudeUsageQuery, StartClaudeUsageQuery } from "../sdk-usage";
import { unsettled } from "./fixtures";

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
    const result = await inspectClaudeUsage(() => usageQuery(usageResponse));

    expect(result).toStrictEqual({
      _tag: "ok",
      value: {
        subscriptionType: "team",
        rateLimitsAvailable: true,
        windows: [
          {
            name: "Current session",
            usedPercent: 12,
            resetsAt: "2026-08-31T14:50:00.000Z",
          },
          { name: "Weekly", usedPercent: 29, resetsAt: "2026-09-02T09:00:00.000Z" },
          { name: "Fable weekly", usedPercent: 49, resetsAt: null },
        ],
        extraUsageEnabled: false,
      },
    });
    assert(result._tag === "ok", "test setup: expected parsed usage");
    const formatted = formatClaudeUsageStatus(result.value);
    expect(formatted).toContain("Current session: 88% remaining");
    expect(formatted).toContain("Weekly: 71% remaining");
    expect(formatted).toContain("Fable weekly: 51% remaining");
    expect(formatted).toContain("Extra usage: disabled");
  });

  test("reports unavailable plan limits without inventing usage", async () => {
    const result = await inspectClaudeUsage(() =>
      usageQuery({ subscription_type: null, rate_limits_available: false, rate_limits: null }),
    );

    assert(result._tag === "ok", "test setup: expected parsed usage");
    expect(formatClaudeUsageStatus(result.value)).toBe(
      "Claude plan usage is unavailable for the current authentication method.",
    );
  });

  test("rejects malformed experimental SDK responses", async () => {
    const result = await inspectClaudeUsage(() =>
      usageQuery({
        subscription_type: "team",
        rate_limits_available: true,
        rate_limits: { five_hour: {} },
      }),
    );

    expect(result).toMatchObject({ _tag: "err", error: { operation: "parse" } });
  });

  test("classifies startup, read, and cleanup failures", async () => {
    const startup = await inspectClaudeUsage(() => {
      throw new Error("spawn failed");
    });
    const read = await inspectClaudeUsage(() => ({
      readUsage: async () => {
        throw new Error("request failed");
      },
      close: async () => undefined,
    }));
    const close = await inspectClaudeUsage(() => ({
      readUsage: async () => usageResponse,
      close: async () => {
        throw new Error("close failed");
      },
    }));

    expect(startup).toMatchObject({ _tag: "err", error: { operation: "start" } });
    expect(read).toMatchObject({ _tag: "err", error: { operation: "read" } });
    expect(close).toMatchObject({ _tag: "err", error: { operation: "close" } });
  });

  test("times out a usage request that never responds", async () => {
    const result = await inspectClaudeUsage(
      () => ({
        readUsage: async () => unsettled(),
        close: async () => undefined,
      }),
      1,
    );

    expect(result).toMatchObject({ _tag: "err", error: { operation: "timeout" } });
  });

  test("bounds cleanup after both a successful read and a read timeout", async () => {
    vi.useFakeTimers();
    try {
      const successfulRead = inspectClaudeUsage(
        () => ({
          readUsage: async () => usageResponse,
          close: async () => unsettled(),
        }),
        10,
      );
      const timedOutRead = inspectClaudeUsage(
        () => ({
          readUsage: async () => unsettled(),
          close: async () => unsettled(),
        }),
        10,
      );

      await vi.runAllTimersAsync();
      const [cleanupResult, readResult] = await Promise.all([successfulRead, timedOutRead]);

      expect(cleanupResult).toMatchObject({ _tag: "err", error: { operation: "close" } });
      expect(readResult).toMatchObject({ _tag: "err", error: { operation: "timeout" } });
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

    const result = await inspectClaudeUsage(start);

    expect(result._tag).toBe("ok");
    expect(observedSignal?.aborted).toBe(true);
  });
});
