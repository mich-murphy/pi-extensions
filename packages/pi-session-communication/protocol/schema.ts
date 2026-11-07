import { Schema } from "effect";

function noControls(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || (code >= 127 && code <= 159)) {
      return false;
    }
  }
  return true;
}

function text(maximum: number, controls = true) {
  return Schema.String.check(
    Schema.makeFilter<string>(
      (value) =>
        value.length > 0 &&
        value.isWellFormed() &&
        Buffer.byteLength(value, "utf8") <= maximum &&
        (controls || noControls(value)),
    ),
  );
}

const randomId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u));
const machineId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/u));
const key = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/u));
const natural = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  Schema.makeFilter<number>((value) => !Object.is(value, -0)),
);
const revision = natural;
const label = text(128, false);
const scopeIds = (maximum: number) =>
  Schema.Array(key).check(
    Schema.makeFilter<readonly string[]>(
      (values) =>
        values.length > 0 && values.length <= maximum && new Set(values).size === values.length,
    ),
  );
const boundedArray = <S extends Schema.Constraint>(item: S, maximum: number) =>
  Schema.Array(item).check(
    Schema.makeFilter<readonly S["Type"][]>((values) => values.length <= maximum),
  );

const Peer = Schema.Struct({
  machineId,
  sessionId: text(256, false),
  runtimeNonce: randomId,
});
export type PeerRef = typeof Peer.Type;
const work = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("request"), origin: Peer, requestId: randomId }),
  Schema.Struct({ kind: Schema.Literal("publication"), publisher: Peer, key }),
]);
const status = Schema.Literals([
  "accepted",
  "declined",
  "needs_clarification",
  "planned",
  "in_progress",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);
const format = Schema.Literals(["text", "markdown", "git-diff", "git-format-patch"]);
const category = Schema.Literals(["context", "research", "spec", "plan", "finding", "work"]);
const refs = boundedArray(
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal("publication"), publisher: Peer, key, revision }),
    Schema.Struct({
      kind: Schema.Literal("resource"),
      machineId,
      locator: text(1024, false),
      label: Schema.optionalKey(label),
    }),
  ]),
  8,
);
const reportFields = {
  work: Schema.optionalKey(work),
  status: Schema.optionalKey(status),
  refs: Schema.optionalKey(refs),
};
export const Message = Schema.Struct({
  id: randomId,
  kind: Schema.Literals(["request", "reply", "update"]),
  content: text(24_576),
  format,
  ...reportFields,
  replyTo: Schema.optionalKey(Schema.Struct({ sender: Peer, messageId: randomId })),
}).check(
  Schema.makeFilter(
    (message) =>
      (message.kind !== "reply" || message.replyTo !== undefined) &&
      (message.kind !== "request" || message.status === undefined),
  ),
);
export type Message = typeof Message.Type;

const publication = Schema.Struct({
  key,
  revision,
  category,
  title: text(128),
  summary: text(1024),
  content: Schema.optionalKey(text(24_576)),
  format,
  ...reportFields,
  preparation: Schema.Literals(["authored", "summarized", "curated"]),
}).check(
  Schema.makeFilter((record) =>
    record.category === "work" ? record.work !== undefined : record.status === undefined,
  ),
);
const summary = Schema.Struct({
  key,
  revision,
  category,
  title: text(128),
  work: Schema.optionalKey(work),
  status: Schema.optionalKey(status),
}).check(
  Schema.makeFilter((record) =>
    record.category === "work" ? record.work !== undefined : record.status === undefined,
  ),
);
const workSummary = Schema.Struct({ key, revision, status: Schema.optionalKey(status) });
const descriptor = Schema.Struct({ peer: Peer, label, scopeIds: scopeIds(4) });
const routing = { from: Schema.optionalKey(Peer), publisher: Peer, scopeId: key };
const head = { v: Schema.Literal(1), rid: randomId };

const requests = [
  Schema.Struct({
    ...head,
    op: Schema.Literal("register"),
    sessionId: text(256, false),
    runtimeNonce: randomId,
    scopeIds: scopeIds(4),
    label,
  }),
  Schema.Struct({ ...head, op: Schema.Literal("close") }),
  Schema.Struct({ ...head, op: Schema.Literal("ping") }),
  Schema.Struct({
    ...head,
    op: Schema.Literal("discover"),
    scopeIds: scopeIds(64),
    watch: Schema.Boolean,
  }),
  Schema.Struct({ ...head, op: Schema.Literal("unwatch"), watchRid: randomId }),
  Schema.Struct({
    ...head,
    op: Schema.Literal("send"),
    from: Schema.optionalKey(Peer),
    to: Peer,
    scopeId: key,
    message: Message,
  }),
  Schema.Struct({
    ...head,
    op: Schema.Literal("deliver"),
    from: Peer,
    to: Peer,
    scopeId: key,
    message: Message,
  }),
  Schema.Struct({
    ...head,
    op: Schema.Literal("state.get"),
    ...routing,
    key,
    expectedRevision: Schema.optionalKey(revision),
  }),
  Schema.Struct({ ...head, op: Schema.Literal("state.list"), ...routing }),
  Schema.Struct({ ...head, op: Schema.Literal("interest.add"), ...routing, work }),
  Schema.Struct({ ...head, op: Schema.Literal("interest.remove"), ...routing, work }),
] as const;

const binding = Schema.Struct({ messageId: randomId, sender: Peer, recipient: Peer, scopeId: key });
const resource = Schema.Literals([
  "registrations",
  "inbox",
  "receipts",
  "relations",
  "interests",
  "publications",
  "operations",
  "buffers",
  "watch",
]);
const baseCodes = ["forbidden", "unavailable"] as const;
const routedCodes = [...baseCodes, "no_route"] as const;
const deliveryCodes = [
  ...routedCodes,
  "id_conflict",
  "invalid_correlation",
  "delivery_too_large",
] as const;
const sendCodes = [...deliveryCodes, "protocol_error", "cancelled"] as const;
function failure<const C extends readonly string[]>(codes: C) {
  return Schema.Union([
    Schema.Struct({ tag: Schema.Literal("error"), code: Schema.Literals(codes) }),
    Schema.Struct({ tag: Schema.Literal("error"), code: Schema.Literal("overloaded"), resource }),
  ]);
}
function result<
  const O extends string,
  S extends Schema.Constraint,
  const C extends readonly string[],
>(op: O, value: S, codes: C) {
  return Schema.Struct({
    ...head,
    op: Schema.Literal("result"),
    forOp: Schema.Literal(op),
    outcome: Schema.Union([Schema.Struct({ tag: Schema.Literal("ok"), value }), failure(codes)]),
  });
}
const interestBase = { publisher: Peer, scopeId: key, work };
const terminal = new Set(["completed", "failed", "cancelled", "declined"]);
const inactive = Schema.Struct({
  ...interestBase,
  active: Schema.Literal(false),
  current: workSummary,
}).check(
  Schema.makeFilter(
    (value) => value.current.status !== undefined && terminal.has(value.current.status),
  ),
);
const interestAdded = Schema.Union([
  Schema.Struct({
    ...interestBase,
    active: Schema.Literal(true),
    expiresInMs: Schema.Literal(86_400_000),
    current: Schema.optionalKey(workSummary),
  }).check(
    Schema.makeFilter(
      (value) => value.current?.status === undefined || !terminal.has(value.current.status),
    ),
  ),
  inactive,
]);
const admittedOutcome = Schema.Struct({
  tag: Schema.Literal("admitted"),
  binding,
  correlation: Schema.Literals(["none", "verified", "unresolved"]),
});
const overloadedOutcome = Schema.Struct({
  tag: Schema.Literal("not_admitted"),
  binding,
  code: Schema.Literal("overloaded"),
  resource,
});
const deliveryOutcome = Schema.Union([
  admittedOutcome,
  overloadedOutcome,
  Schema.Struct({
    tag: Schema.Literal("not_admitted"),
    binding,
    code: Schema.Literals(deliveryCodes),
  }),
]);
const sendOutcome = Schema.Union([
  admittedOutcome,
  overloadedOutcome,
  Schema.Struct({ tag: Schema.Literal("not_admitted"), binding, code: Schema.Literals(sendCodes) }),
  Schema.Struct({
    tag: Schema.Literal("unknown"),
    binding,
    code: Schema.Literals(["unavailable", "protocol_error", "cancelled"]),
  }),
]);
const results = [
  result("register", Schema.Struct({ peer: Peer, scopeIds: scopeIds(4) }), [
    ...baseCodes,
    "already_registered",
    "descriptor_too_large",
  ]),
  result("close", Schema.Struct({}), baseCodes),
  result("ping", Schema.Struct({}), baseCodes),
  result("unwatch", Schema.Struct({}), baseCodes),
  result(
    "discover",
    Schema.Struct({ peers: boundedArray(descriptor, 60), watching: Schema.Boolean }),
    baseCodes,
  ),
  result("state.get", Schema.Struct({ publisher: Peer, scopeId: key, publication }), [
    ...routedCodes,
    "not_found",
    "revision_mismatch",
  ]),
  result(
    "state.list",
    Schema.Struct({ publisher: Peer, scopeId: key, revision, items: boundedArray(summary, 16) }),
    routedCodes,
  ),
  result("interest.add", interestAdded, [...routedCodes, "not_found"]),
  result(
    "interest.remove",
    Schema.Struct({ ...interestBase, active: Schema.Literal(false) }),
    routedCodes,
  ),
  Schema.Struct({
    ...head,
    op: Schema.Literal("result"),
    forOp: Schema.Literal("send"),
    outcome: sendOutcome,
  }),
  Schema.Struct({
    ...head,
    op: Schema.Literal("result"),
    forOp: Schema.Literal("deliver"),
    outcome: deliveryOutcome,
  }),
] as const;
const event = Schema.Struct({
  ...head,
  op: Schema.Literal("roster.event"),
  event: Schema.Union([
    Schema.Struct({ tag: Schema.Literal("upsert"), peer: descriptor }),
    Schema.Struct({ tag: Schema.Literal("remove"), peer: Peer }),
    Schema.Struct({
      tag: Schema.Literal("invalidated"),
      reason: Schema.Literals(["overflow", "policy_changed"]),
    }),
  ]),
});
export const Frame = Schema.Union([...requests, ...results, event]);
export type Frame = typeof Frame.Type;
export type WorkRef = typeof work.Type;
export type Publication = typeof publication.Type;
