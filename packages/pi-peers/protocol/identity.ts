import { createHash } from "node:crypto";
import type { Message, PeerRef } from "./schema.js";

export function samePeer(left: PeerRef, right: PeerRef): boolean {
  return (
    left.machineId === right.machineId &&
    left.sessionId === right.sessionId &&
    left.runtimeNonce === right.runtimeNonce
  );
}

export function scopedMessageKey(
  sender: PeerRef,
  recipient: PeerRef,
  scopeId: string,
  messageId: string,
): string {
  return JSON.stringify([
    sender.machineId,
    sender.sessionId,
    sender.runtimeNonce,
    recipient.machineId,
    recipient.sessionId,
    recipient.runtimeNonce,
    scopeId,
    messageId,
  ]);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => stableValue(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([name, child]) => [name, stableValue(child)]),
    );
  }
  return value;
}

export function sameMessage(left: Message, right: Message): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

export function messageFingerprint(message: Message): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(message)), "utf8")
    .digest("hex");
}
