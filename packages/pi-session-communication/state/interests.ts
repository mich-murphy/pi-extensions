import { samePeer } from "../protocol/identity.js";
import type { PeerRef, Publication, WorkRef } from "../protocol/schema.js";
import { encodeFrame } from "../protocol/wire.js";
import { currentWork, workSummary, preparePublication, commitPublication } from "./publications.js";
import {
  allowed,
  hasRecipientCapacity,
  interestKey,
  knownWork,
  peerKey,
  recipients,
  refreshRelations,
  terminal,
} from "./shared.js";
import type {
  InterestInput,
  InterestValue,
  PushPlan,
  ReportInput,
  ReportPlan,
  Result,
  Store,
  WorkSummary,
} from "./types.js";

function interestPolicy(store: Store, input: InterestInput): boolean {
  return (
    allowed(store, "interest", input.subscriber, store.peer, input.scopeId) &&
    allowed(store, "read", input.subscriber, store.peer, input.scopeId) &&
    allowed(store, "push", store.peer, input.subscriber, input.scopeId)
  );
}
function interestValue(
  store: Store,
  input: InterestInput,
  active: boolean,
  current?: WorkSummary,
): InterestValue {
  return {
    publisher: store.peer,
    scopeId: input.scopeId,
    work: input.work,
    active,
    ...(active ? { expiresInMs: store.limits.interestTtlMs } : {}),
    ...(current === undefined ? {} : { current }),
  };
}
export function addInterest(
  store: Store,
  authored: InterestInput,
  now: number,
): Result<InterestValue> {
  const input = structuredClone(authored);
  if (!interestPolicy(store, input)) {
    return { tag: "error", code: "forbidden" };
  }
  const current = currentWork(store, input.scopeId, input.work);
  if (current === undefined && !knownWork(store, input.scopeId, input.work)) {
    return { tag: "error", code: "not_found" };
  }
  const key = interestKey(input.subscriber, input.scopeId, input.work);
  if (current?.status !== undefined && terminal.has(current.status)) {
    store.interests.delete(key);
    return { tag: "ok", value: interestValue(store, input, false, workSummary(current)) };
  }
  if (
    !store.interests.has(key) &&
    store.interests.size + store.relations.size >= store.limits.relationsAndInterests
  ) {
    return { tag: "error", code: "overloaded", resource: "interests" };
  }
  if (!hasRecipientCapacity(store, input.scopeId, input.work, input.subscriber)) {
    return { tag: "error", code: "overloaded", resource: "interests" };
  }
  store.interests.set(key, { ...input, expiresAt: now + store.limits.interestTtlMs });
  return {
    tag: "ok",
    value: interestValue(
      store,
      input,
      true,
      current === undefined ? undefined : workSummary(current),
    ),
  };
}
export function removeInterest(store: Store, input: InterestInput): Result<InterestValue> {
  if (!allowed(store, "interest", input.subscriber, store.peer, input.scopeId)) {
    return { tag: "error", code: "forbidden" };
  }
  store.interests.delete(interestKey(input.subscriber, input.scopeId, input.work));
  return { tag: "ok", value: interestValue(store, input, false) };
}
function reportRecipients(store: Store, input: ReportInput, work: WorkRef): Result<PeerRef[]> {
  const selected =
    input.notify === "selected" ? input.recipients : recipients(store, input.scopeId, work);
  if (selected === undefined || (input.notify === "interested" && input.recipients !== undefined)) {
    return { tag: "error", code: "invalid_recipients" };
  }
  if (
    selected.length > store.limits.recipientsPerWork ||
    (input.notify === "selected" && selected.length === 0) ||
    new Set(selected.map((peer) => peerKey(peer))).size !== selected.length
  ) {
    return { tag: "error", code: "invalid_recipients" };
  }
  if (
    selected.some(
      (peer) =>
        samePeer(peer, store.peer) || !allowed(store, "push", store.peer, peer, input.scopeId),
    )
  ) {
    return { tag: "error", code: "forbidden" };
  }
  return { tag: "ok", value: structuredClone([...selected]) };
}
function pushPlan(store: Store, publication: Publication, scopeId: string, to: PeerRef): PushPlan {
  const message = {
    id: store.newMessageId(),
    kind: "update",
    format: "text",
    content: `${publication.title}: ${publication.summary}`,
    ...(publication.work === undefined ? {} : { work: publication.work }),
    ...(publication.status === undefined ? {} : { status: publication.status }),
    refs: [
      {
        kind: "publication",
        publisher: store.peer,
        key: publication.key,
        revision: publication.revision,
      },
    ],
  } as const;
  // Expanded envelope preflight includes both exact authenticated identities.
  encodeFrame(
    { v: 1, op: "deliver", rid: "0".repeat(32), from: store.peer, to, scopeId, message },
    "adapter-delivery",
  );
  return { to, scopeId, message };
}
function preparePushes(
  store: Store,
  publication: Publication,
  scopeId: string,
  selected: readonly PeerRef[],
): Result<PushPlan[]> {
  try {
    const pushes = selected.map((peer) => pushPlan(store, publication, scopeId, peer));
    if (new Set(pushes.map((push) => push.message.id)).size !== pushes.length) {
      return { tag: "error", code: "invalid_record" };
    }
    return { tag: "ok", value: pushes };
  } catch {
    return { tag: "error", code: "invalid_record" };
  }
}
function consumeSelected(
  store: Store,
  scopeId: string,
  work: WorkRef,
  selected: readonly PeerRef[],
): PeerRef[] {
  const consumed: PeerRef[] = [];
  for (const peer of selected) {
    if (store.interests.delete(interestKey(peer, scopeId, work))) {
      consumed.push(peer);
    }
  }
  return consumed;
}
export function prepareReport(store: Store, input: ReportInput, now: number): Result<ReportPlan> {
  if (input.record.category !== "work" || input.record.work === undefined) {
    return { tag: "error", code: "invalid_record" };
  }
  const prepared = preparePublication(store, input);
  if (prepared.tag !== "ok") {
    return prepared;
  }
  const selected = reportRecipients(store, input, input.record.work);
  if (selected.tag !== "ok") {
    return selected;
  }
  const pushes = preparePushes(store, prepared.value.publication, input.scopeId, selected.value);
  if (pushes.tag !== "ok") {
    return pushes;
  }
  if (pushes.value.length > 0 && !store.reservePushes(pushes.value.length)) {
    return { tag: "error", code: "overloaded", resource: "operations" };
  }
  const isTerminal = input.record.status !== undefined && terminal.has(input.record.status);
  // No await/callback after this point: publish, snapshot and one-shot consumption commit together.
  const publication = commitPublication(store, prepared.value);
  const consumedInterests = isTerminal
    ? consumeSelected(store, input.scopeId, input.record.work, selected.value)
    : [];
  refreshRelations(store, input.scopeId, input.record.work, now, isTerminal);
  return {
    tag: "ok",
    value: structuredClone({ publication, pushes: pushes.value, consumedInterests }),
  };
}
