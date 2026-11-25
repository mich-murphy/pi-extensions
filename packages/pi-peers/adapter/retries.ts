import type { Message, PeerRef } from "../protocol/schema.js";
import { defaults } from "../state/shared.js";

const RETRY_WINDOW_MS = defaults.receiptTtlMs - 120_000;

export type Unsure = {
  readonly handle: string;
  readonly to: PeerRef;
  readonly scopeId: string;
  readonly message: Message;
  readonly at: number;
};

export class UnsureSends {
  private readonly entries = new Map<string, Unsure>();
  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly limit = 64,
  ) {}
  record(entry: Omit<Unsure, "at">): void {
    if (this.entries.has(entry.message.id)) {
      return;
    }

    this.entries.set(entry.message.id, { ...entry, at: this.now() });
    const oldest = this.entries.keys().next();

    if (this.entries.size > this.limit && oldest.done !== true) {
      this.entries.delete(oldest.value);
    }
  }
  lookup(messageId: string): { entry: Unsure; expired: boolean } | undefined {
    const entry = this.entries.get(messageId);

    if (entry === undefined) {
      return undefined;
    }

    const expired = this.now() - entry.at >= RETRY_WINDOW_MS;

    if (expired) {
      this.entries.delete(messageId);
    }

    return { entry, expired };
  }
  settle(messageId: string): void {
    this.entries.delete(messageId);
  }
}
