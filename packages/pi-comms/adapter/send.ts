import { setTimeout as delay } from "node:timers/promises";
import type { Frame, Message, PeerRef } from "../protocol/schema.js";
import { encodeFrame } from "../protocol/wire.js";
import { ConnectionFailure, freshId } from "./transport.js";
import type { Reply } from "./transport.js";

export type SendOutcome = Extract<Frame, { op: "result"; forOp: "send" }>["outcome"];
type Binding = SendOutcome["binding"];
function failure(
  binding: Binding,
  possible: boolean,
  code: "unavailable" | "protocol_error" | "cancelled",
): SendOutcome {
  return possible ? { tag: "unknown", binding, code } : { tag: "not_admitted", binding, code };
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
function terminalReply(reply: Reply, binding: Binding, possible: boolean): SendOutcome {
  if (reply.forOp !== "send") {
    return failure(binding, true, "protocol_error");
  }
  if (reply.outcome.tag === "admitted" || reply.outcome.tag === "unknown" || !possible) {
    return reply.outcome;
  }
  return failure(binding, true, "unavailable");
}
function terminalFailure(
  error: ConnectionFailure,
  binding: Binding,
  possible: boolean,
): SendOutcome {
  if (error.code === "overloaded") {
    return possible
      ? failure(binding, true, "unavailable")
      : { tag: "not_admitted", binding, code: "overloaded", resource: "operations" };
  }
  return failure(binding, possible, error.code);
}
async function backoff(
  retryIndex: number,
  deadline: number,
  signal?: AbortSignal,
): Promise<"ready" | "expired" | "cancelled"> {
  const milliseconds = (retryIndex === 0 ? 100 : 500) + Math.floor(Math.random() * 51);
  if (performance.now() + milliseconds >= deadline) {
    return "expired";
  }
  try {
    await delay(milliseconds, undefined, signal === undefined ? {} : { signal });
    return "ready";
  } catch {
    return "cancelled";
  }
}
/** One invocation, fixed authored message, at most three attempts under one monotonic deadline. */
export async function sendWithRetries(options: {
  sender: PeerRef;
  recipient: PeerRef;
  scopeId: string;
  message: Message;
  signal?: AbortSignal;
  request: (rid: string, deadline: number) => Promise<Reply>;
}): Promise<SendOutcome> {
  const binding = {
    messageId: options.message.id,
    sender: options.sender,
    recipient: options.recipient,
    scopeId: options.scopeId,
  };
  try {
    encodeFrame(
      {
        v: 1,
        op: "deliver",
        rid: freshId(),
        from: options.sender,
        to: options.recipient,
        scopeId: options.scopeId,
        message: options.message,
      },
      "adapter-delivery",
    );
  } catch {
    return { tag: "not_admitted", binding, code: "delivery_too_large" };
  }
  const deadline = performance.now() + 15_000;
  let possible = false;
  for (let count = 0; count < 3; count += 1) {
    if (options.signal?.aborted === true) {
      return failure(binding, possible, "cancelled");
    }
    // eslint-disable-next-line eslint/no-await-in-loop -- Attempts must be sequential and share their original deadline.
    const result = await attempt(async () => options.request(freshId(), deadline));
    if (!(result instanceof ConnectionFailure)) {
      return terminalReply(result, binding, possible);
    }
    possible ||= result.possible;
    if (result.code !== "unavailable" || count === 2) {
      return terminalFailure(result, binding, possible);
    }
    // eslint-disable-next-line eslint/no-await-in-loop -- Backoff consumes the same bounded sender budget.
    const pause = await backoff(count, deadline, options.signal);
    if (pause !== "ready") {
      return failure(binding, possible, pause === "cancelled" ? "cancelled" : "unavailable");
    }
  }
  return failure(binding, possible, "unavailable");
}
