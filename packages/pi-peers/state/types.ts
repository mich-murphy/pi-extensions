import type { Frame, Message, PeerRef, Publication, WorkRef } from "../protocol/schema.js";

export type AdmissionOutcome = Extract<Frame, { op: "result"; forOp: "deliver" }>["outcome"];
export type Correlation = Extract<AdmissionOutcome, { tag: "admitted" }>["correlation"];
export type Resource =
  | "inbox"
  | "receipts"
  | "relations"
  | "interests"
  | "publications"
  | "operations";
export type Failure =
  | { tag: "error"; code: "overloaded"; resource: Resource }
  | {
      tag: "error";
      code:
        | "forbidden"
        | "no_route"
        | "not_found"
        | "revision_mismatch"
        | "id_conflict"
        | "invalid_correlation"
        | "invalid_record"
        | "invalid_recipients"
        | "publication_too_large"
        | "summary_list_too_large"
        | "work_conflict"
        | "revision_exhausted";
    };
export type Result<T> = { tag: "ok"; value: T } | Failure;
export type PublicationRecord = Omit<Publication, "key" | "revision">;
export type Summary = Pick<
  Publication,
  "key" | "revision" | "category" | "title" | "work" | "status"
>;
export type WorkSummary = Pick<Publication, "key" | "revision" | "status">;
export type Policy = (query: {
  action: "push" | "read" | "interest";
  from: PeerRef;
  to: PeerRef;
  scopeId: string;
}) => boolean;
export type Limits = {
  inboxMessages: number;
  inboxBytes: number;
  receipts: number;
  publications: number;
  publicationBytes: number;
  relationsAndInterests: number;
  recipientsPerWork: number;
  receiptTtlMs: number;
  relationTtlMs: number;
  terminalRelationTtlMs: number;
  interestTtlMs: number;
};
export type Delivery = {
  key: string;
  from: PeerRef;
  to: PeerRef;
  scopeId: string;
  message: Message;
  correlation: Correlation;
  bytes: number;
};
export type AdmitInput = Omit<Delivery, "key" | "correlation" | "bytes"> & {
  deliveryBytes?: number;
};
export type PublishInput = { scopeId: string; key: string; record: PublicationRecord };
export type ReadInput = {
  caller: PeerRef;
  scopeId: string;
  key: string;
  expectedRevision?: number;
};
export type InterestInput = { subscriber: PeerRef; scopeId: string; work: WorkRef };
export type InterestValue = {
  publisher: PeerRef;
  scopeId: string;
  work: WorkRef;
  active: boolean;
  expiresInMs?: number;
  current?: WorkSummary;
};
export type ReportInput = PublishInput & {
  notify: "interested" | "selected";
  recipients?: readonly PeerRef[];
};
export type PushPlan = { to: PeerRef; scopeId: string; message: Message };
export type ReportPlan = {
  publication: Publication;
  pushes: readonly PushPlan[];
  consumedInterests: readonly PeerRef[];
};
export type Options = {
  peer: PeerRef;
  scopeIds: readonly string[];
  clock: () => number;
  authorize: Policy;
  /** Atomic nonthrowing offer: retain exactly once iff true; must not re-enter the state API. */
  offer: (delivery: Delivery) => boolean;
  /** Last precommit callback. On true, adapter releases one slot per planned push on outcome/discard. */
  reservePushes?: (count: number) => boolean;
  newMessageId?: () => string;
  limits?: Partial<Limits>;
};

export type Receipt = {
  fingerprint: string;
  admittedAt: number;
  outcome: Extract<AdmissionOutcome, { tag: "admitted" }>;
};
export type Outstanding = { delivery: Delivery; submitted: boolean };
export type Relation = {
  direction: "incoming" | "outgoing";
  from: PeerRef;
  to: PeerRef;
  scopeId: string;
  messageId: string;
  work: WorkRef;
  expiresAt: number;
  fingerprint: string;
};
export type Interest = InterestInput & { expiresAt: number };
export type StoredPublication = { scopeId: string; publication: Publication; bytes: number };
export type Store = {
  peer: PeerRef;
  scopeIds: ReadonlySet<string>;
  limits: Limits;
  authorize: Policy;
  offer: Options["offer"];
  newMessageId: () => string;
  reservePushes: (count: number) => boolean;
  receipts: Map<string, Receipt>;
  outstanding: Map<string, Outstanding>;
  relations: Map<string, Relation>;
  interests: Map<string, Interest>;
  publications: Map<string, StoredPublication>;
  revision: number;
  inboxBytes: number;
  publicationBytes: number;
};
