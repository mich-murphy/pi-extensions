import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import type { Duration } from "effect";
import { TestClock } from "effect/testing";
import { ClaudeUsageQueries, formatClaudeUsageStatus, inspectClaudeUsage } from "../sdk-usage";
import type { ClaudeUsageQuery, StartClaudeUsageQuery } from "../sdk-usage";
import { unsettled } from "./fixtures";

const withStart = (start: StartClaudeUsageQuery, timeout?: number) =>
  inspectClaudeUsage(timeout).pipe(Effect.provide(ClaudeUsageQueries.fromStart(start)));
const failureOf = (start: StartClaudeUsageQuery, timeout?: number) =>
  Effect.flip(withStart(start, timeout));

/** Run `effect` in the background, advance virtual time by each step, then join it. */
const afterAdvancing = Effect.fnUntraced(function* <A, E>(
  effect: Effect.Effect<A, E>,
  steps: readonly Duration.Input[],
) {
  const fiber = yield* Effect.forkChild(effect);
  for (const step of steps) {
    yield* TestClock.adjust(step);
  }
  return yield* Fiber.join(fiber);
});

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
  it.effect("reports remaining general and model-specific plan usage", () =>
    Effect.gen(function* () {
      const status = yield* withStart(() => usageQuery(usageResponse));

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
    }),
  );

  it.effect("reports unavailable plan limits without inventing usage", () =>
    Effect.gen(function* () {
      const status = yield* withStart(() =>
        usageQuery({ subscription_type: null, rate_limits_available: false, rate_limits: null }),
      );

      expect(formatClaudeUsageStatus(status)).toBe(
        "Claude plan usage is unavailable for the current authentication method.",
      );
    }),
  );

  it.effect("rejects malformed experimental SDK responses", () =>
    Effect.gen(function* () {
      const error = yield* failureOf(() =>
        usageQuery({
          subscription_type: "team",
          rate_limits_available: true,
          rate_limits: { five_hour: {} },
        }),
      );

      expect(error).toMatchObject({ _tag: "ClaudeUsageInspectionError", operation: "parse" });
      expect(error.message).toBe("Claude returned usage data in an unexpected format");
    }),
  );

  it.effect("classifies startup, read, and cleanup failures with specific messages", () =>
    Effect.gen(function* () {
      const startup = yield* failureOf(() => {
        throw new Error("spawn failed");
      });
      const read = yield* failureOf(() => ({
        readUsage: async () => {
          throw new Error("request failed");
        },
        close: async () => undefined,
      }));
      const close = yield* failureOf(() => ({
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
    }),
  );

  it.effect("reports a read failure rather than a cleanup failure when both fail", () =>
    Effect.gen(function* () {
      const error = yield* failureOf(() => ({
        readUsage: async () => {
          throw new Error("request failed");
        },
        close: async () => {
          throw new Error("close failed");
        },
      }));

      expect(error).toMatchObject({ operation: "read" });
    }),
  );

  it.effect("times out a usage request that never responds", () =>
    Effect.gen(function* () {
      const error = yield* afterAdvancing(
        failureOf(
          () => ({
            readUsage: async () => unsettled(),
            close: async () => undefined,
          }),
          1,
        ),
        [1],
      );

      expect(error._tag).toBe("ClaudeUsageTimeoutError");
      expect(error.message).toBe("Timed out after 1ms waiting for Claude usage");
    }),
  );

  it.effect("bounds cleanup after both a successful read and a read timeout", () =>
    Effect.gen(function* () {
      const [cleanupError, readError] = yield* afterAdvancing(
        Effect.all(
          [
            failureOf(
              () => ({
                readUsage: async () => usageResponse,
                close: async () => unsettled(),
              }),
              10,
            ),
            failureOf(
              () => ({
                readUsage: async () => unsettled(),
                close: async () => unsettled(),
              }),
              10,
            ),
          ],
          { concurrency: "unbounded" },
        ),
        [10, 10],
      );

      expect(cleanupError).toMatchObject({ operation: "close" });
      expect(readError._tag).toBe("ClaudeUsageTimeoutError");
    }),
  );

  it.effect("aborts the idle SDK query after reading usage", () =>
    Effect.gen(function* () {
      let observedSignal: AbortSignal | undefined;
      const start: StartClaudeUsageQuery = (abortController) => {
        observedSignal = abortController.signal;
        return usageQuery(usageResponse);
      };

      yield* withStart(start);

      expect(observedSignal?.aborted).toBe(true);
    }),
  );
});
