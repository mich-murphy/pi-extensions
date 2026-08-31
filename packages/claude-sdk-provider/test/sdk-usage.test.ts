import { describe, expect, test } from "vitest";
import {
  type ClaudeUsageQuery,
  formatClaudeUsageStatus,
  inspectClaudeUsage,
  type StartClaudeUsageQuery,
} from "../sdk-usage";

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

describe("Claude SDK usage", () => {
  test("reports remaining general and model-specific plan usage", async () => {
    const result = await inspectClaudeUsage(() => usageQuery(usageResponse));

    expect(result).toEqual({
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
    if (result._tag !== "ok") throw new Error("test setup: expected parsed usage");
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

    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") throw new Error("test setup: expected parsed usage");
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

    expect(result._tag).toBe("err");
    if (result._tag === "err") expect(result.error.operation).toBe("parse");
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

    expect(startup._tag === "err" && startup.error.operation).toBe("start");
    expect(read._tag === "err" && read.error.operation).toBe("read");
    expect(close._tag === "err" && close.error.operation).toBe("close");
  });

  test("times out a usage request that never responds", async () => {
    const result = await inspectClaudeUsage(
      () => ({
        readUsage: () => new Promise<unknown>(() => undefined),
        close: async () => undefined,
      }),
      1,
    );

    expect(result._tag === "err" && result.error.operation).toBe("timeout");
  });

  test("aborts the idle SDK query after reading usage", async () => {
    let observedSignal: AbortSignal | undefined;
    const start: StartClaudeUsageQuery = (signal) => {
      observedSignal = signal;
      return usageQuery(usageResponse);
    };

    const result = await inspectClaudeUsage(start);

    expect(result._tag).toBe("ok");
    expect(observedSignal?.aborted).toBe(true);
  });
});
