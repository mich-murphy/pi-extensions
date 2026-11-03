import { afterEach, describe, expect, test, vi } from "vitest";
import type { BridgeEvent } from "../bridge";
import { SdkOverageError } from "../sdk/errors";
import { diagnoseSdkRunError, formatSdkRunError } from "../sdk/failure-diagnostics";
import { createClaudeAgentSdkRunner } from "../sdk/runner";
import type { RunSdkQuery } from "../sdk/runner";
import { drain, requestFixture, resultMessage, sonnet } from "./fixtures";

const RESET = 1_792_548_000;

function limit(info: unknown) {
  return { type: "rate_limit_event", rate_limit_info: info, uuid: "u", session_id: "s" };
}

async function run(messages: readonly unknown[]) {
  let signal: AbortSignal | undefined;
  async function* query(params: Parameters<RunSdkQuery>[0]) {
    signal = params.options?.abortController?.signal;
    yield* messages;
  }
  const events = await drain(
    createClaudeAgentSdkRunner({ runSdkQuery: query })(requestFixture(), sonnet, {}),
  );
  return { events, signal };
}

function lastFailure(events: readonly BridgeEvent[]) {
  const last = events.at(-1);
  if (last?.type !== "failed") {
    throw new Error("test setup: expected a failed event");
  }
  return last.error;
}

function failureTags(events: readonly BridgeEvent[]): string[] {
  return events.flatMap((event) => (event.type === "failed" ? [event.error._tag] : []));
}

describe("Extra Usage guard", () => {
  const overage = limit({ status: "allowed", isUsingOverage: true, overageResetsAt: RESET });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("fails the turn with a typed error and requests abort when not allowed", async () => {
    vi.stubEnv("PI_CLAUDE_SDK_ALLOW_EXTRA_USAGE", "");
    const { events, signal } = await run([overage, resultMessage({})]);
    const error = lastFailure(events);
    expect(error).toBeInstanceOf(SdkOverageError);
    expect(error.message).toBe(
      `This turn would be billed to Extra Usage; plan limits are exhausted until ${new Date(RESET * 1000).toISOString()}. Set PI_CLAUDE_SDK_ALLOW_EXTRA_USAGE=1 to allow.`,
    );
    expect(diagnoseSdkRunError(error).kind).toBe("usage-limit");
    expect(formatSdkRunError(error)).toContain("Extra Usage");
    expect(signal?.aborted).toBe(true);
  });

  test("lets the turn finish when opted in", async () => {
    vi.stubEnv("PI_CLAUDE_SDK_ALLOW_EXTRA_USAGE", "1");
    const { events } = await run([overage, resultMessage({})]);
    expect(failureTags(events)).not.toContain("SdkOverageError");
  });

  test("a plain rejected window keeps the existing behaviour", async () => {
    vi.stubEnv("PI_CLAUDE_SDK_ALLOW_EXTRA_USAGE", "");
    const { events } = await run([
      limit({ status: "rejected", resetsAt: RESET }),
      resultMessage({ is_error: true, terminal_reason: "blocking_limit" }),
    ]);
    expect(lastFailure(events)._tag).toBe("SdkResultError");
  });
});
