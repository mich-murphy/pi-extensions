import assert from "node:assert/strict";
import { samePeer } from "../protocol/identity.js";
import type { PeerRef } from "../protocol/schema.js";
import type { Reply, Request } from "./transport.js";

function registration(
  request: Extract<Request, { op: "register" }>,
  reply: Reply,
  self: PeerRef,
): void {
  assert(reply.forOp === "register");
  if (reply.outcome.tag !== "ok") {
    return;
  }
  assert(samePeer(reply.outcome.value.peer, self), "Registration identity mismatch");
  assert(
    reply.outcome.value.scopeIds.every((scope) => request.scopeIds.includes(scope)),
    "Registration scope mismatch",
  );
}
function sendBinding(request: Extract<Request, { op: "send" }>, reply: Reply): void {
  assert(reply.forOp === "send");
  assert(reply.outcome.messageId === request.message.id, "Message binding mismatch");
}
function discovery(request: Extract<Request, { op: "discover" }>, reply: Reply): void {
  assert(reply.forOp === "discover");
  if (reply.outcome.tag !== "ok") {
    return;
  }
  assert(reply.outcome.value.watching === request.watch, "Watch binding mismatch");
  assert(
    reply.outcome.value.peers.every((peer) =>
      peer.scopeIds.every((scope) => request.scopeIds.includes(scope)),
    ),
    "Discovery scope mismatch",
  );
}
export function validateBoundReply(request: Request, reply: Reply, self: PeerRef): void {
  assert(request.op === reply.forOp, "Operation binding mismatch");
  switch (request.op) {
    case "register": {
      registration(request, reply, self);
      break;
    }
    case "send": {
      sendBinding(request, reply);
      break;
    }
    case "discover": {
      discovery(request, reply);
      break;
    }
    case "gateway.restart":
    case "close":
    case "deliver":
    case "ping":
    case "unwatch":
    case "state.get":
    case "state.list":
    case "interest.add":
    case "interest.remove": {
      break;
    }
  }
}
