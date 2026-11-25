import type { Message, PeerRef } from "../protocol/schema.js";
import { admit, rememberOutgoing, retire, take } from "./admission.js";
import { defaults, sweep } from "./shared.js";
import type { AdmitInput, Options, Store } from "./types.js";

function createStore(options: Options): Store {
  const limits = { ...defaults, ...options.limits };

  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Invalid state limit: ${name}`);
    }
  }

  if (
    limits.receiptTtlMs < defaults.receiptTtlMs ||
    limits.relationTtlMs !== defaults.relationTtlMs ||
    limits.recipientsPerWork > 8
  ) {
    throw new TypeError("State limits violate the v1 retention or fanout contract");
  }

  return {
    peer: structuredClone(options.peer),
    scopeIds: new Set(options.scopeIds),
    limits,
    authorize: options.authorize,
    offer: options.offer,
    receipts: new Map(),
    outstanding: new Map(),
    relations: new Map(),
    inboxBytes: 0,
  };
}

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
    stats: () =>
      operation(() => ({
        inboxMessages: store.outstanding.size,
        inboxBytes: store.inboxBytes,
        receipts: store.receipts.size,
        relations: store.relations.size,
      })),
  };
}

export type SessionState = ReturnType<typeof createState>;
