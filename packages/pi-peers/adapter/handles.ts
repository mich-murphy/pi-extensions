import { createHash } from "node:crypto";
import { samePeer } from "../protocol/identity.js";
import type { PeerRef } from "../protocol/schema.js";

function digest(machineId: string, sessionId: string): string {
  return createHash("sha256").update(`${machineId}\n${sessionId}`, "utf8").digest("hex");
}
function sessionKey(peer: Pick<PeerRef, "machineId" | "sessionId">): string {
  return JSON.stringify([peer.machineId, peer.sessionId]);
}
export function sessionHandle(machineId: string, sessionId: string): string {
  return `s-${digest(machineId, sessionId).slice(0, 4)}`;
}
export type Bound = { readonly peer: PeerRef; readonly scopeId: string };
export class Handles {
  private readonly handles = new Map<string, string>();
  private readonly owners = new Map<string, string>();
  private readonly runtimes = new Map<string, Bound>();
  private base(peer: PeerRef): string {
    const key = sessionKey(peer);
    const known = this.handles.get(key);
    if (known !== undefined) {
      return known;
    }
    const hex = digest(peer.machineId, peer.sessionId);
    let length = 4;
    while (length < hex.length && this.owners.has(`s-${hex.slice(0, length)}`)) {
      length += 2;
    }
    const handle = `s-${hex.slice(0, length)}`;
    this.handles.set(key, handle);
    this.owners.set(handle, key);
    return handle;
  }
  private kept(peer: PeerRef): string | undefined {
    const base = this.base(peer);
    for (let count = 1; ; count += 1) {
      const handle = count === 1 ? base : `${base}/${count}`;
      const bound = this.runtimes.get(handle);
      if (bound === undefined) {
        return undefined;
      }
      if (samePeer(bound.peer, peer)) {
        return handle;
      }
    }
  }
  list<T extends Bound>(entries: readonly T[]): (T & { handle: string; restarted: boolean })[] {
    const listed = entries.map((entry) => entry.peer);
    const kept = entries.map((entry) => this.kept(entry.peer));
    const taken = new Set(kept.filter((handle) => handle !== undefined));
    return entries.map((entry, index) => {
      const own = kept[index];
      const handle = own ?? this.vacant(entry.peer, taken, listed);
      taken.add(handle);
      const previous = this.runtimes.get(handle);
      this.runtimes.set(handle, { peer: entry.peer, scopeId: entry.scopeId });
      return { ...entry, handle, restarted: own === undefined && previous !== undefined };
    });
  }
  private vacant(peer: PeerRef, taken: ReadonlySet<string>, listed: readonly PeerRef[]): string {
    const base = this.base(peer);
    for (let count = 1; ; count += 1) {
      const handle = count === 1 ? base : `${base}/${count}`;
      const bound = this.runtimes.get(handle);
      if (
        !taken.has(handle) &&
        (bound === undefined || !listed.some((other) => samePeer(other, bound.peer)))
      ) {
        return handle;
      }
    }
  }
  sender(peer: PeerRef, scopeId: string): string {
    const base = this.base(peer);
    let count = 1;
    for (;;) {
      const handle = count === 1 ? base : `${base}/${count}`;
      const bound = this.runtimes.get(handle);
      if (bound === undefined) {
        this.runtimes.set(handle, { peer, scopeId });
        return handle;
      }
      if (samePeer(bound.peer, peer)) {
        return handle;
      }
      count += 1;
    }
  }
  resolve(handle: string): Bound | undefined {
    return this.runtimes.get(handle);
  }
}
export class TakenIndex {
  private readonly entries = new Map<string, Bound>();
  constructor(private readonly limit = 256) {}
  record(messageId: string, entry: Bound): void {
    this.entries.delete(messageId);
    this.entries.set(messageId, entry);
    const oldest = this.entries.keys().next();
    if (this.entries.size > this.limit && oldest.done !== true) {
      this.entries.delete(oldest.value);
    }
  }
  find(messageId: string): Bound | undefined {
    return this.entries.get(messageId);
  }
}
