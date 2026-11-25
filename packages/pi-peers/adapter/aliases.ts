const ID = /^[0-9a-f]{32}$/u;

export class MessageAliases {
  private readonly byId = new Map<string, string>();
  private readonly byAlias = new Map<string, string>();
  private readonly retired = new Set<string>();
  constructor(private readonly limit = 4096) {}
  alias(id: string): string {
    const known = this.byId.get(id);
    if (known !== undefined) {
      return known;
    }
    let length = 4;
    while (length < id.length && this.used(`m-${id.slice(0, length)}`)) {
      length += 2;
    }
    const alias = `m-${id.slice(0, length)}`;
    this.byId.set(id, alias);
    this.byAlias.set(alias, id);
    const oldest = this.byId.entries().next();
    if (this.byId.size > this.limit && oldest.done !== true) {
      this.byId.delete(oldest.value[0]);
      this.byAlias.delete(oldest.value[1]);
      this.retired.add(oldest.value[1]);
    }
    return alias;
  }
  private used(alias: string): boolean {
    return this.byAlias.has(alias) || this.retired.has(alias);
  }
  resolve(reference: string): string | undefined {
    return this.byAlias.get(reference) ?? (ID.test(reference) ? reference : undefined);
  }
}
