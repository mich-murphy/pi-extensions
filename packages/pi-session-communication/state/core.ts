import { randomBytes } from "node:crypto";
import type { Message, PeerRef } from "../protocol/schema.js";
import { admit, rememberOutgoing, retire, take } from "./admission.js";
import { addInterest, prepareReport, removeInterest } from "./interests.js";
import { list, publish, read, removePublication } from "./publications.js";
import { defaults, sweep } from "./shared.js";
import type {
  AdmitInput,
  InterestInput,
  Options,
  PublishInput,
  ReadInput,
  ReportInput,
  Store,
} from "./types.js";

function createStore(options: Options): Store {
  const limits = { ...defaults, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Invalid state limit: ${name}`);
    }
  }
  if (
    limits.receiptTtlMs < defaults.receiptTtlMs ||
    limits.interestTtlMs !== defaults.interestTtlMs ||
    limits.relationTtlMs !== defaults.relationTtlMs ||
    limits.terminalRelationTtlMs !== defaults.terminalRelationTtlMs ||
    limits.recipientsPerWork > 8
  ) {
    throw new TypeError("State limits violate the v1 retention or fanout contract");
  }
  return {
    peer: structuredClone(options.peer),
    scopeIds: new Set(options.scopeIds),
    limits,
    reservePushes: options.reservePushes ?? (() => true),
    authorize: options.authorize,
    offer: options.offer,
    newMessageId: options.newMessageId ?? (() => randomBytes(16).toString("hex")),
    receipts: new Map(),
    outstanding: new Map(),
    relations: new Map(),
    interests: new Map(),
    publications: new Map(),
    revision: 0,
    inboxBytes: 0,
    publicationBytes: 0,
  };
}

/** One adapter lifetime. Every operation is synchronous; public callbacks must not re-enter it. */
export function createState(options: Options) {
  const store = createStore(options);
  let busy = false;
  let lastNow = 0;
  function operation<T>(run: (now: number) => T): T {
    if (busy) {
      throw new Error("Session state callback re-entry is forbidden");
    }
    busy = true;
    try {
      const now = options.clock();
      if (!Number.isFinite(now) || now < lastNow) {
        throw new TypeError("Session state requires a nondecreasing monotonic clock");
      }
      lastNow = now;
      sweep(store, now);
      return run(now);
    } finally {
      busy = false;
    }
  }
  return {
    admit: (input: AdmitInput) => operation((now) => admit(store, input, now)),
    rememberOutgoing: (input: { to: PeerRef; scopeId: string; message: Message }) =>
      operation((now) => rememberOutgoing(store, input, now)),
    take: (key?: string) => operation(() => take(store, key)),
    retire: (key: string) => operation(() => retire(store, key)),
    publish: (input: PublishInput) => operation(() => publish(store, input)),
    remove: (input: { scopeId: string; key: string }) =>
      operation(() => removePublication(store, input)),
    read: (input: ReadInput) => operation(() => read(store, input)),
    list: (input: { caller: PeerRef; scopeId: string }) => operation(() => list(store, input)),
    interest: {
      add: (input: InterestInput) => operation((now) => addInterest(store, input, now)),
      remove: (input: InterestInput) => operation(() => removeInterest(store, input)),
    },
    prepareReport: (input: ReportInput) => operation((now) => prepareReport(store, input, now)),
    stats: () =>
      operation(() => ({
        inboxMessages: store.outstanding.size,
        inboxBytes: store.inboxBytes,
        receipts: store.receipts.size,
        relations: store.relations.size,
        interests: store.interests.size,
        publications: store.publications.size,
        publicationBytes: store.publicationBytes,
        revision: store.revision,
      })),
  };
}
export type SessionState = ReturnType<typeof createState>;
