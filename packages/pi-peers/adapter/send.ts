import { setTimeout as delay } from "node:timers/promises";
import type { Frame, Message, PeerRef } from "../protocol/schema.js";
import { encodeFrame } from "../protocol/wire.js";
import { ConnectionFailure, freshId } from "./transport.js";
import type { Reply } from "./transport.js";

export type SendOutcome = Extract<Frame, { op: "result"; forOp: "send" }>["outcome"];

export const SEND_BUDGET_MS = 15_000;

export function remainingBudget(deadline: number): number {
  return Math.min(SEND_BUDGET_MS, Math.max(0, Math.floor(deadline - performance.now())));
}

function failure(
  messageId: string,
  possible: boolean,
  code: "unavailable" | "protocol_error" | "cancelled",
): SendOutcome {
  return possible ? { tag: "unknown", messageId, code } : { tag: "not_admitted", messageId, code };
}

async function attempt(run: () => Promise<Reply>): Promise<Reply | ConnectionFailure> {
  try {
    return await run();
  } catch (error) {
    return error instanceof ConnectionFailure
      ? error
      : new ConnectionFailure("protocol_error", false);
  }
}

function terminalReply(reply: Reply, messageId: string, possible: boolean): SendOutcome {
  if (reply.forOp !== "send") {
    return failure(messageId, true, "protocol_error");
  }

  if (reply.outcome.tag === "admitted" || reply.outcome.tag === "unknown" || !possible) {
    return reply.outcome;
  }

  return failure(messageId, true, "unavailable");
}

function terminalFailure(
  error: ConnectionFailure,
  messageId: string,
  possible: boolean,
): SendOutcome {
  if (error.code === "overloaded") {
    return possible
      ? failure(messageId, true, "unavailable")
      : { tag: "not_admitted", messageId, code: "overloaded", resource: "operations" };
  }

  return failure(messageId, possible, error.code);
}

export type Delay = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

const realDelay: Delay = async (milliseconds, signal) => {
  await delay(milliseconds, undefined, signal === undefined ? {} : { signal });
};

async function backoff(
  retryIndex: number,
  deadline: number,
  wait: Delay,
  signal?: AbortSignal,
): Promise<"ready" | "expired" | "cancelled"> {
  const milliseconds = (retryIndex === 0 ? 100 : 500) + Math.floor(Math.random() * 51);

  if (performance.now() + milliseconds >= deadline) {
    return "expired";
  }

  try {
    await wait(milliseconds, signal);

    return "ready";
  } catch {
    return "cancelled";
  }
}

export async function sendWithRetries(options: {
  sender: PeerRef;
  recipient: PeerRef;
  scopeId: string;
  message: Message;
  signal?: AbortSignal;
  request: (rid: string, deadline: number) => Promise<Reply>;
  delay?: Delay;
}): Promise<SendOutcome> {
  const messageId = options.message.id;

  try {
    encodeFrame(
      {
        v: 2,
        op: "deliver",
        rid: freshId(),
        from: options.sender,
        to: options.recipient,
        scopeId: options.scopeId,
        budgetMs: SEND_BUDGET_MS,
        message: options.message,
      },
      "adapter-delivery",
    );
  } catch {
    return { tag: "not_admitted", messageId, code: "delivery_too_large" };
  }

  const deadline = performance.now() + SEND_BUDGET_MS;
  let possible = false;

  for (let count = 0; count < 3; count += 1) {
    if (options.signal?.aborted === true) {
      return failure(messageId, possible, "cancelled");
    }

    // eslint-disable-next-line eslint/no-await-in-loop -- Attempts must be sequential and share their original deadline.
    const result = await attempt(async () => options.request(freshId(), deadline));

    if (!(result instanceof ConnectionFailure)) {
      return terminalReply(result, messageId, possible);
    }

    possible ||= result.possible;

    if (result.code !== "unavailable" || count === 2) {
      return terminalFailure(result, messageId, possible);
    }

    // eslint-disable-next-line eslint/no-await-in-loop -- Backoff consumes the same bounded sender budget.
    const pause = await backoff(count, deadline, options.delay ?? realDelay, options.signal);

    if (pause !== "ready") {
      return failure(messageId, possible, pause === "cancelled" ? "cancelled" : "unavailable");
    }
  }

  return failure(messageId, possible, "unavailable");
}
