import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { samePeer } from "../protocol/identity.js";
import type { PeerRef } from "../protocol/schema.js";
import type { Reply, Request } from "./transport.js";

function publisherBinding(
  expected: { publisher: PeerRef; scopeId: string },
  value: { publisher: PeerRef; scopeId: string },
): void {
  assert(
    samePeer(value.publisher, expected.publisher) && value.scopeId === expected.scopeId,
    "Publisher binding mismatch",
  );
}
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
function sendBinding(request: Extract<Request, { op: "send" }>, reply: Reply, self: PeerRef): void {
  assert(reply.forOp === "send");
  const binding = reply.outcome.binding;
  assert(
    binding.messageId === request.message.id && binding.scopeId === request.scopeId,
    "Message binding mismatch",
  );
  assert(
    samePeer(binding.sender, self) && samePeer(binding.recipient, request.to),
    "Peer binding mismatch",
  );
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
function publication(request: Extract<Request, { op: "state.get" }>, reply: Reply): void {
  assert(reply.forOp === "state.get");
  if (reply.outcome.tag !== "ok") {
    return;
  }
  publisherBinding(request, reply.outcome.value);
  const record = reply.outcome.value.publication;
  assert(record.key === request.key, "Publication key mismatch");
  assert(
    request.expectedRevision === undefined || record.revision === request.expectedRevision,
    "Publication revision mismatch",
  );
}
function listing(request: Extract<Request, { op: "state.list" }>, reply: Reply): void {
  assert(reply.forOp === "state.list");
  if (reply.outcome.tag === "ok") {
    publisherBinding(request, reply.outcome.value);
  }
}
function interest(
  request: Extract<Request, { op: "interest.add" | "interest.remove" }>,
  reply: Reply,
): void {
  assert(reply.forOp === "interest.add" || reply.forOp === "interest.remove");
  if (reply.outcome.tag !== "ok") {
    return;
  }
  publisherBinding(request, reply.outcome.value);
  assert(isDeepStrictEqual(reply.outcome.value.work, request.work), "Work binding mismatch");
}
/** Structural validation has already run. Live replies must match their exact originating operation. */
export function validateBoundReply(request: Request, reply: Reply, self: PeerRef): void {
  assert(request.op === reply.forOp, "Operation binding mismatch");
  switch (request.op) {
    case "register": {
      registration(request, reply, self);
      break;
    }
    case "send": {
      sendBinding(request, reply, self);
      break;
    }
    case "discover": {
      discovery(request, reply);
      break;
    }
    case "state.get": {
      publication(request, reply);
      break;
    }
    case "state.list": {
      listing(request, reply);
      break;
    }
    case "interest.add":
    case "interest.remove": {
      interest(request, reply);
      break;
    }
    case "gateway.restart":
    case "close":
    case "deliver":
    case "ping":
    case "unwatch": {
      break;
    }
  }
}
