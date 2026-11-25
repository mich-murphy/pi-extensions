import { samePeer } from "../protocol/identity.js";
import type { PeerRef, WorkRef } from "../protocol/schema.js";
import type { Failure, Limits, Store } from "./types.js";

export const defaults: Limits = {
  inboxMessages: 64,
  inboxBytes: 1_048_576,
  receipts: 1024,
  relations: 256,
  recipientsPerWork: 8,
  receiptTtlMs: 600_000,
  relationTtlMs: 86_400_000,
};

function peerKey(peer: PeerRef): string {
  return JSON.stringify([peer.machineId, peer.sessionId, peer.runtimeNonce]);
}

function workKey(scopeId: string, work: WorkRef): string {
  return JSON.stringify(
    work.kind === "request"
      ? [scopeId, "request", peerKey(work.origin), work.requestId]
      : [scopeId, "publication", peerKey(work.publisher), work.key],
  );
}

export function allowed(
  store: Store,
  action: "push",
  from: PeerRef,
  to: PeerRef,
  scopeId: string,
): boolean {
  return store.scopeIds.has(scopeId) && store.authorize({ action, from, to, scopeId });
}

export function overload(resource: Extract<Failure, { code: "overloaded" }>["resource"]): Failure {
  return { tag: "error", code: "overloaded", resource };
}

export function sweep(store: Store, now: number): void {
  for (const [key, receipt] of store.receipts) {
    if (!store.outstanding.has(key) && now >= receipt.admittedAt + store.limits.receiptTtlMs) {
      store.receipts.delete(key);
    }
  }

  for (const [key, relation] of store.relations) {
    if (now >= relation.expiresAt) {
      store.relations.delete(key);
    }
  }
}

export function hasRecipientCapacity(
  store: Store,
  scopeId: string,
  work: WorkRef,
  candidate: PeerRef,
): boolean {
  const key = workKey(scopeId, work);
  const peers = new Map<string, PeerRef>();

  for (const relation of store.relations.values()) {
    if (relation.direction === "incoming" && workKey(relation.scopeId, relation.work) === key) {
      peers.set(peerKey(relation.from), relation.from);
    }
  }

  const existing = [...peers.values()];

  return (
    existing.some((peer) => samePeer(peer, candidate)) ||
    existing.length < store.limits.recipientsPerWork
  );
}
