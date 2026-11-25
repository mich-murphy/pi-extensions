const LIMIT = 256;

export class SentReceipts {
  private readonly durable = new Map<string, boolean>();
  constructor(private readonly limit = LIMIT) {}
  record(messageId: string, durable: boolean): void {
    this.durable.delete(messageId);
    this.durable.set(messageId, durable);
    const oldest = this.durable.keys().next();
    if (this.durable.size > this.limit && oldest.done !== true) {
      this.durable.delete(oldest.value);
    }
  }
  durableFor(messageId: string): boolean | undefined {
    return this.durable.get(messageId);
  }
}
