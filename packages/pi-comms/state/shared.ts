import { samePeer } from "../protocol/identity.js";
import type { PeerRef, WorkRef } from "../protocol/schema.js";
import type { Failure, Limits, Relation, Store } from "./types.js";

export const defaults: Limits = {
  inboxMessages: 64,
  inboxBytes: 1_048_576,
  receipts: 1024,
  publications: 16,
  publicationBytes: 524_288,
  relationsAndInterests: 256,
  recipientsPerWork: 8,
  receiptTtlMs: 600_000,
  relationTtlMs: 86_400_000,
  terminalRelationTtlMs: 3_600_000,
  interestTtlMs: 86_400_000,
};
export const terminal = new Set(["completed", "failed", "cancelled", "declined"]);
export function peerKey(peer: PeerRef): string {
  return JSON.stringify([peer.machineId, peer.sessionId, peer.runtimeNonce]);
}
export function workKey(scopeId: string, work: WorkRef): string {
  return JSON.stringify(
    work.kind === "request"
      ? [scopeId, "request", peerKey(work.origin), work.requestId]
      : [scopeId, "publication", peerKey(work.publisher), work.key],
  );
}
export function publicationKey(scopeId: string, key: string): string {
  return JSON.stringify([scopeId, key]);
}
export function interestKey(subscriber: PeerRef, scopeId: string, work: WorkRef): string {
  return JSON.stringify([peerKey(subscriber), workKey(scopeId, work)]);
}
export function allowed(
  store: Store,
  action: "push" | "read" | "interest",
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
  for (const [key, interest] of store.interests) {
    if (now >= interest.expiresAt) {
      store.interests.delete(key);
    }
  }
}
function requesters(store: Store, scopeId: string, work: WorkRef): PeerRef[] {
  const peers = new Map<string, PeerRef>();
  const key = workKey(scopeId, work);
  for (const relation of store.relations.values()) {
    if (relation.direction === "incoming" && workKey(relation.scopeId, relation.work) === key) {
      peers.set(peerKey(relation.from), relation.from);
    }
  }
  return [...peers.values()];
}
function interestedPeers(store: Store, scopeId: string, work: WorkRef): PeerRef[] {
  const key = workKey(scopeId, work);
  return [...store.interests.values()]
    .filter((interest) => workKey(interest.scopeId, interest.work) === key)
    .map((interest) => interest.subscriber);
}
export function recipients(store: Store, scopeId: string, work: WorkRef): PeerRef[] {
  const peers = new Map(
    [...requesters(store, scopeId, work), ...interestedPeers(store, scopeId, work)].map((peer) => [
      peerKey(peer),
      peer,
    ]),
  );
  return [...peers.values()];
}
export function hasRecipientCapacity(
  store: Store,
  scopeId: string,
  work: WorkRef,
  candidate: PeerRef,
): boolean {
  const existing = recipients(store, scopeId, work);
  return (
    existing.some((peer) => samePeer(peer, candidate)) ||
    existing.length < store.limits.recipientsPerWork
  );
}
export function refreshRelations(
  store: Store,
  scopeId: string,
  work: WorkRef,
  now: number,
  isTerminal: boolean,
): void {
  const key = workKey(scopeId, work);
  for (const relation of store.relations.values()) {
    if (workKey(relation.scopeId, relation.work) === key) {
      relation.expiresAt =
        now +
        (isTerminal
          ? Math.min(store.limits.relationTtlMs, store.limits.terminalRelationTtlMs)
          : store.limits.relationTtlMs);
    }
  }
}
export function knownWork(store: Store, scopeId: string, work: WorkRef): boolean {
  const key = workKey(scopeId, work);
  return [...store.relations.values()].some(
    (relation: Relation) => workKey(relation.scopeId, relation.work) === key,
  );
}
