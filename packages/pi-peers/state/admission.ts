import { messageFingerprint, samePeer, scopedMessageKey } from "../protocol/identity.js";
import { MAX_BUDGET_MS } from "../protocol/schema.js";
import type { Message, PeerRef, WorkRef } from "../protocol/schema.js";
import { encodeFrame } from "../protocol/wire.js";
import { allowed, hasRecipientCapacity, overload } from "./shared.js";
import type {
  AdmissionOutcome,
  AdmitInput,
  Correlation,
  Delivery,
  Failure,
  Relation,
  Result,
  Store,
} from "./types.js";

function root(from: PeerRef, message: Message): WorkRef {
  return message.work ?? { kind: "request", origin: from, requestId: message.id };
}

function correlation(store: Store, input: AdmitInput): Correlation | Failure {
  const reply = input.message.replyTo;

  if (reply === undefined) {
    return "none";
  }

  if (!samePeer(reply.sender, input.to)) {
    return { tag: "error", code: "invalid_correlation" };
  }

  const relations = [...store.relations.values()].filter(
    (relation) =>
      relation.direction === "outgoing" &&
      samePeer(relation.from, reply.sender) &&
      relation.messageId === reply.messageId,
  );

  if (relations.length === 0) {
    return "unresolved";
  }

  return relations.some(
    (relation) => relation.scopeId === input.scopeId && samePeer(relation.to, input.from),
  )
    ? "verified"
    : { tag: "error", code: "invalid_correlation" };
}

function requestRelation(
  store: Store,
  input: AdmitInput,
  now: number,
): Relation | Failure | undefined {
  if (input.message.kind !== "request") {
    return undefined;
  }

  const key = scopedMessageKey(input.from, input.to, input.scopeId, input.message.id);

  if (!store.relations.has(key) && store.relations.size >= store.limits.relations) {
    return overload("relations");
  }

  const work = root(input.from, input.message);

  if (!hasRecipientCapacity(store, input.scopeId, work, input.from)) {
    return overload("relations");
  }

  return {
    direction: "incoming",
    from: input.from,
    to: input.to,
    scopeId: input.scopeId,
    messageId: input.message.id,
    work,
    expiresAt: now + store.limits.relationTtlMs,
    fingerprint: messageFingerprint(input.message),
  };
}

function reservationFailure(store: Store, bytes: number): Failure | undefined {
  if (store.receipts.size >= store.limits.receipts) {
    return overload("receipts");
  }

  if (
    store.outstanding.size >= store.limits.inboxMessages ||
    store.inboxBytes + bytes > store.limits.inboxBytes
  ) {
    return overload("inbox");
  }

  return undefined;
}

function rejection(input: AdmitInput, failure: Failure): AdmissionOutcome {
  const messageId = input.message.id;

  if (failure.code === "overloaded") {
    return { tag: "not_admitted", messageId, code: "overloaded", resource: failure.resource };
  }

  if (
    failure.code === "forbidden" ||
    failure.code === "no_route" ||
    failure.code === "id_conflict" ||
    failure.code === "invalid_correlation"
  ) {
    return { tag: "not_admitted", messageId, code: failure.code };
  }

  throw new Error("Unexpected admission failure");
}

function admissionPolicy(store: Store, input: AdmitInput): Failure | undefined {
  if (!samePeer(input.to, store.peer)) {
    return { tag: "error", code: "no_route" };
  }

  if (!allowed(store, "push", input.from, input.to, input.scopeId)) {
    return { tag: "error", code: "forbidden" };
  }

  return undefined;
}

export function admit(store: Store, authored: AdmitInput, now: number): AdmissionOutcome {
  const input = structuredClone(authored);

  const encoded = encodeFrame(
    {
      v: 2,
      op: "deliver",
      rid: "0".repeat(32),
      from: input.from,
      to: input.to,
      scopeId: input.scopeId,
      budgetMs: MAX_BUDGET_MS,
      message: input.message,
    },
    "adapter-delivery",
  );

  const bytes = input.deliveryBytes ?? encoded.length;

  if (!Number.isSafeInteger(bytes) || bytes < encoded.length || bytes > 32_768) {
    throw new TypeError("Invalid serialized delivery byte charge");
  }

  const denied = admissionPolicy(store, input);

  if (denied !== undefined) {
    return rejection(input, denied);
  }

  const key = scopedMessageKey(input.from, input.to, input.scopeId, input.message.id);
  const fingerprint = messageFingerprint(input.message);
  const prior = store.receipts.get(key);

  if (prior !== undefined) {
    return prior.fingerprint === fingerprint
      ? structuredClone(prior.outcome)
      : rejection(input, { tag: "error", code: "id_conflict" });
  }

  const classification = correlation(store, input);

  if (
    classification !== "none" &&
    classification !== "unresolved" &&
    classification !== "verified"
  ) {
    return rejection(input, classification);
  }

  const capacity = reservationFailure(store, bytes);

  if (capacity !== undefined) {
    return rejection(input, capacity);
  }

  const relation = requestRelation(store, input, now);

  if (relation !== undefined && "tag" in relation) {
    return rejection(input, relation);
  }

  const delivery: Delivery = {
    key,
    from: input.from,
    to: input.to,
    scopeId: input.scopeId,
    message: input.message,
    correlation: classification,
    bytes,
  };

  const outcome = {
    tag: "admitted",
    messageId: input.message.id,
    correlation: classification,
    durable: false,
  } as const;

  if (!store.offer(delivery)) {
    return rejection(input, overload("inbox"));
  }

  store.receipts.set(key, { fingerprint, admittedAt: now, outcome });
  store.outstanding.set(key, { delivery, submitted: false });
  store.inboxBytes += bytes;

  if (relation !== undefined) {
    store.relations.set(key, relation);
  }

  return structuredClone(outcome);
}

export function rememberOutgoing(
  store: Store,
  input: { to: PeerRef; scopeId: string; message: Message },
  now: number,
): Result<string> {
  const validated = structuredClone(input);
  encodeFrame(
    { v: 2, op: "send", rid: "0".repeat(32), budgetMs: MAX_BUDGET_MS, ...validated },
    "local-client",
  );

  if (validated.message.kind !== "request") {
    return { tag: "error", code: "invalid_record" };
  }

  if (!allowed(store, "push", store.peer, validated.to, validated.scopeId)) {
    return { tag: "error", code: "forbidden" };
  }

  const key = scopedMessageKey(store.peer, validated.to, validated.scopeId, validated.message.id);
  const fingerprint = messageFingerprint(validated.message);
  const prior = store.relations.get(key);

  if (prior !== undefined) {
    return prior.fingerprint === fingerprint
      ? { tag: "ok", value: key }
      : { tag: "error", code: "id_conflict" };
  }

  if (store.relations.size >= store.limits.relations) {
    return overload("relations");
  }

  store.relations.set(key, {
    direction: "outgoing",
    from: store.peer,
    to: validated.to,
    scopeId: validated.scopeId,
    messageId: validated.message.id,
    work: root(store.peer, validated.message),
    fingerprint,
    expiresAt: now + store.limits.relationTtlMs,
  });

  return { tag: "ok", value: key };
}

export function take(store: Store, key?: string): Delivery | undefined {
  const entry =
    key === undefined
      ? [...store.outstanding.values()].find((item) => !item.submitted)
      : store.outstanding.get(key);

  if (entry === undefined || entry.submitted) {
    return undefined;
  }

  entry.submitted = true;

  return structuredClone(entry.delivery);
}

export function retire(store: Store, key: string): boolean {
  const entry = store.outstanding.get(key);

  if (entry === undefined) {
    return false;
  }

  store.outstanding.delete(key);
  store.inboxBytes -= entry.delivery.bytes;

  return true;
}
