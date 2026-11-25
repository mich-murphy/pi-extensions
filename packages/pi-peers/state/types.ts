import type { Frame, Message, PeerRef, WorkRef } from "../protocol/schema.js";

export type AdmissionOutcome = Extract<Frame, { op: "result"; forOp: "deliver" }>["outcome"];

export type Correlation = Extract<AdmissionOutcome, { tag: "admitted" }>["correlation"];

export type Resource = "inbox" | "receipts" | "relations" | "operations";

export type Failure =
  | { tag: "error"; code: "overloaded"; resource: Resource }
  | {
      tag: "error";
      code: "forbidden" | "no_route" | "id_conflict" | "invalid_correlation" | "invalid_record";
    };

export type Result<T> = { tag: "ok"; value: T } | Failure;

export type Policy = (query: {
  action: "push";
  from: PeerRef;
  to: PeerRef;
  scopeId: string;
}) => boolean;

export type Limits = {
  inboxMessages: number;
  inboxBytes: number;
  receipts: number;
  relations: number;
  recipientsPerWork: number;
  receiptTtlMs: number;
  relationTtlMs: number;
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

export type Options = {
  peer: PeerRef;
  scopeIds: readonly string[];
  clock: () => number;
  authorize: Policy;
  offer: (delivery: Delivery) => boolean;
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

export type Store = {
  peer: PeerRef;
  scopeIds: ReadonlySet<string>;
  limits: Limits;
  authorize: Policy;
  offer: Options["offer"];
  receipts: Map<string, Receipt>;
  outstanding: Map<string, Outstanding>;
  relations: Map<string, Relation>;
  inboxBytes: number;
};
